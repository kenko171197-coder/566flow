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
const _MotionBulkModal = class _MotionBulkModal {
  constructor({
    userId,
    flowProjectId,
    profile,
    quota,
    resumeItems = [],
    onDone = () => {},
  }) {
    this.userId = userId;
    this.flowProjectId = flowProjectId;
    this.profile = profile;
    this.quota = quota;
    this.showFlowVoice = profile?.settings?.show_flow_voice !== false;
    this.onDone = onDone;
    this.references = { mode: "character_only", character: [], background: [] };
    this.resumeItems = resumeItems;
    this.bulkCreateId = resumeItems[0]?.bulkCreateId || crypto.randomUUID();
    this.busy = false;
    this.uploading = false;
    this.closed = false;
    this.selectedIds = new Set();
  }
  t(key, fallback) {
    const value = window.I18n?.t?.(key);
    return value && value !== key ? value : fallback;
  }
  element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== void 0) node.textContent = text;
    return node;
  }
  button(text, action) {
    const button = this.element("button", "btn btn-secondary", text);
    button.type = "button";
    button.addEventListener("click", action);
    return button;
  }
  field(parent, label, input, tag = "label") {
    const wrap = this.element(tag, "motion-bulk-field setting-field");
    wrap.append(this.element("span", "", label), input);
    parent.append(wrap);
    return wrap;
  }
  icon(name) {
    const icon = this.element(
      "span",
      `motion-bulk-icon motion-bulk-icon-${name}`,
    );
    icon.setAttribute("aria-hidden", "true");
    if (["chatgpt", "gemini", "flow"].includes(name))
      icon.innerHTML = window.ProviderBrandIcons?.get?.(name) || "";
    if (["delete", "download"].includes(name))
      icon.innerHTML =
        name === "delete"
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 3v7m4-7v7"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m-4-4 4 4 4-4M5 17v3h14v-3"/></svg>';
    return icon;
  }
  select(options) {
    const select = this.element("select");
    for (const item of options) {
      const option = this.element("option", "", item.label);
      option.value = item.value;
      select.append(option);
    }
    return select;
  }
  initRatioPicker() {
    const wrap = this.element("div", "motion-ratio-picker");
    this.ratio.before(wrap);
    wrap.append(this.ratio);
    this.ratio.hidden = true;
    const trigger = this.button("", () => {
      list.hidden = !list.hidden;
      trigger.setAttribute("aria-expanded", String(!list.hidden));
    });
    trigger.className = "motion-ratio-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute(
      "aria-label",
      this.t("motionEditor.text014", "Video ratio"),
    );
    const list = this.element("div", "motion-ratio-options");
    list.setAttribute("role", "listbox");
    list.hidden = true;
    const icon = (value) => {
      const [width, height] = value.split(":").map(Number),
        mark = this.element("span", "motion-ratio-option-icon");
      mark.style.width = `${Math.max(7, Math.round((16 * width) / Math.max(width, height)))}px`;
      mark.style.height = `${Math.max(7, Math.round((16 * height) / Math.max(width, height)))}px`;
      mark.setAttribute("aria-hidden", "true");
      return mark;
    };
    this.renderRatioPicker = () => {
      trigger.replaceChildren(
        icon(this.ratio.value || this.ratio.options[0].value),
        document.createTextNode(this.ratio.value || "\u2014"),
        this.icon("arrow"),
      );
      list.replaceChildren();
      for (const option of this.ratio.options) {
        const row = this.button("", () => {
          this.ratio.value = option.value;
          list.hidden = true;
          trigger.setAttribute("aria-expanded", "false");
          this.ratio.dispatchEvent(new Event("change", { bubbles: true }));
          trigger.focus();
        });
        row.className = "";
        row.setAttribute("role", "option");
        row.setAttribute(
          "aria-selected",
          String(option.value === this.ratio.value),
        );
        row.append(
          icon(option.value),
          document.createTextNode(option.textContent),
        );
        list.append(row);
      }
    };
    wrap.append(trigger, list);
    this.ratio.addEventListener("change", this.renderRatioPicker);
    this.renderRatioPicker();
    this.root.addEventListener("click", (event) => {
      if (!wrap.contains(event.target)) {
        list.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
      }
    });
    wrap.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !list.hidden) {
        event.stopPropagation();
        list.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
        trigger.focus();
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      list.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      const options = [...list.querySelectorAll("button")],
        current = options.indexOf(document.activeElement);
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
      options[next]?.focus();
    });
  }
  initLanguagePicker() {
    this.language.hidden = true;
    const dialog = this.element(
      "dialog",
      "language-picker-dialog motion-bulk-language-dialog",
    );
    const header = this.element("div", "language-picker-header");
    const close = this.button("\xD7", () => dialog.close());
    close.setAttribute("aria-label", this.t("common.close", "Close"));
    header.append(
      this.element(
        "strong",
        "",
        this.t("motionEditor.text170", "Choose a country"),
      ),
      close,
    );
    const search = this.element("input");
    search.type = "search";
    search.placeholder = this.t(
      "motionBatchRecovery.searchLanguage",
      "Search country or language",
    );
    search.setAttribute("aria-label", search.placeholder);
    const list = this.element("div", "language-picker-list");
    this.renderLanguageTrigger = () => {
      this.languageTriggerLabel.textContent =
        this.language.selectedOptions[0]?.label ||
        this.t("motionEditor.text107", "Keep original language");
    };
    const choose = (value) => {
      this.language.value = value;
      if (!value) this.translate.checked = false;
      this.renderLanguageTrigger();
      this.renderVisibility();
      dialog.close();
      this.languageTrigger.focus();
    };
    const render = () => {
      const normalize = (value) =>
        String(value)
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase();
      const query = normalize(search.value.trim());
      list.replaceChildren();
      for (const item of this.allLanguages.filter(
        (item2) =>
          !query || normalize(`${item2.label} ${item2.value}`).includes(query),
      )) {
        const button = this.button(
          item.value
            ? item.label
            : this.t(
                "motionEditor.text171",
                "Keep original language \xB7 no translation",
              ),
          () => choose(item.value),
        );
        button.className = "";
        list.append(button);
      }
      if (!list.childElementCount)
        list.textContent = this.t(
          "motionEditor.text172",
          "No countries found.",
        );
    };
    this.languageTrigger = this.button("", () => {
      if (this.busy || this.uploading) return;
      search.value = "";
      render();
      dialog.showModal();
      search.focus();
    });
    this.languageTrigger.classList.add("language-trigger");
    this.languageTrigger.setAttribute("aria-haspopup", "dialog");
    this.languageTrigger.setAttribute(
      "aria-labelledby",
      this.languageRow.firstChild.id,
    );
    this.languageTriggerLabel = this.element(
      "span",
      "motion-bulk-language-label",
    );
    this.languageTrigger.append(this.languageTriggerLabel, this.icon("arrow"));
    this.languageRow.append(this.languageTrigger);
    this.renderLanguageTrigger();
    dialog.append(header, search, list);
    this.languageDialog = dialog;
  }
  languageOptions() {
    const locale = window.I18n?.getLocale?.() || "en";
    const cached = _MotionBulkModal.languageCache.get(locale);
    if (cached)
      return [
        {
          value: "",
          label: this.t("motionEditor.text170", "Choose a country"),
        },
        ...cached,
      ];
    const countries = new Intl.DisplayNames([locale], { type: "region" });
    const englishCountries = new Intl.DisplayNames(["en"], { type: "region" });
    const languages = new Intl.DisplayNames(["en"], { type: "language" });
    const rows = [];
    for (let a = 65; a <= 90; a++)
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        const region = new Intl.Locale(`und-${code}`);
        const english = englishCountries.of(code);
        if (
          region.region !== code ||
          !english ||
          english === code ||
          ["EU", "UN", "XA", "XB"].includes(code)
        )
          continue;
        const language = region.maximize().language;
        if (!language || language === "und") continue;
        const name = languages.of(language) || language;
        rows.push({
          value: `${name} (${code})`,
          label: `${countries.of(code) || english} \xB7 ${name} (${code})`,
        });
      }
    rows.sort((a, b) => a.label.localeCompare(b.label, locale));
    _MotionBulkModal.languageCache.set(locale, rows);
    return [
      { value: "", label: this.t("motionEditor.text170", "Choose a country") },
      ...rows,
    ];
  }
  async open() {
    if (!navigator.locks?.request) throw new Error("PROJECT_LOCK_UNAVAILABLE");
    await new Promise((resolve, reject) => {
      this.batchLock = navigator.locks
        .request(
          `motion-bulk-modal:${this.userId}:${this.bulkCreateId}`,
          { ifAvailable: true },
          async (lock) => {
            if (!lock) {
              reject(new Error("MOTION_BULK_ITEM_ACTIVE"));
              return;
            }
            await new Promise((release) => {
              this.releaseBatchLock = release;
              resolve();
            });
          },
        )
        .catch(reject);
    });
    try {
      return await this._open();
    } catch (error) {
      this.close();
      throw error;
    }
  }
  async _open() {
    this.previousFocus = document.activeElement;
    const target = await window.MessageBridge.getProjectTargetContext(
      this.flowProjectId,
    );
    if (
      target?.projectId !== this.flowProjectId ||
      !Number.isInteger(target.tabId) ||
      !target.driverKey
    )
      throw new Error("MOTION_FLOW_PROJECT_MISMATCH");
    const pcm = window.ProviderConfigManager;
    await pcm?._fetchApiConfigs?.();
    const ratios =
      pcm
        ?.getRatiosSync?.("flow", "video")
        ?.map((r) => (typeof r === "string" ? r : r?.value))
        ?.filter(
          (value) =>
            typeof value === "string" && /^[0-9]{1,2}:[0-9]{1,2}$/.test(value),
        ) || [];
    const resolutions =
      pcm
        ?.getDownloadResolutionsSync?.("flow")
        ?.video?.filter((item) => item?.value && item?.label) || [];
    if (
      !ratios.length ||
      !resolutions.length ||
      !window.videoSplitTool?.constructor?.MAX_SOURCE_BYTES
    )
      throw new Error("MOTION_BULK_CONFIG_UNAVAILABLE");
    MotionBulkCreator._context(this.userId, this.flowProjectId);
    this.root = this.element("div", "motion-bulk-overlay");
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    const panel = this.element("section", "motion-bulk-modal");
    const header = this.element(
      "header",
      "motion-bulk-header gen-batch-modal-header",
    );
    const title = this.element(
      "strong",
      "",
      this.t("motionBatch.createTitle", "Create Motion projects"),
    );
    title.id = `motion-bulk-${this.bulkCreateId}`;
    this.root.setAttribute("aria-labelledby", title.id);
    const close = this.button("", () => this.close());
    close.className = "gen-batch-modal-close";
    close.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 5 19 19M19 5 5 19"/></svg>';
    close.setAttribute("aria-label", this.t("common.close", "Close"));
    title.prepend(this.icon("video"));
    header.append(title, close);
    const body = this.element("div", "motion-bulk-body");
    const videoArea = this.element("div", "motion-bulk-video-area");
    const settings = this.element(
      "div",
      "motion-bulk-settings motion-settings",
    );
    settings.append(
      this.element(
        "p",
        "motion-bulk-settings-hint",
        this.t(
          "motionBatch.sharedSettings",
          "These settings apply to every project created here.",
        ),
      ),
    );
    this.videoArea = videoArea;
    this.settingsPanel = settings;
    this.ratio = this.select(ratios.map((value) => ({ value, label: value })));
    this.resolution = this.select(
      resolutions.map((item) => ({ value: item.value, label: item.label })),
    );
    await window.storageSettings?.init?.();
    MotionBulkCreator._context(this.userId, this.flowProjectId);
    const defaults = window.storageSettings?.getSettings?.() || {};
    const preferredResolution = defaults.videoDownloadResolution;
    if (ratios.includes(defaults.defaultVideoRatio))
      this.ratio.value = defaults.defaultVideoRatio;
    if (resolutions.some((item) => item.value === preferredResolution))
      this.resolution.value = preferredResolution;
    const ratioRow = this.element("div", "motion-field-row");
    settings.append(ratioRow);
    this.field(
      ratioRow,
      this.t("motionEditor.text014", "Video ratio"),
      this.ratio,
    ).firstChild.prepend(this.icon("ratio"));
    this.field(
      ratioRow,
      this.t("motionEditor.text016", "Flow resolution"),
      this.resolution,
    ).firstChild.prepend(this.icon("camera"));
    this.initRatioPicker();
    this.refMode = this.select([
      {
        value: "character_only",
        label: this.t("motionEditor.text018", "Character only"),
      },
      {
        value: "character_background",
        label: this.t(
          "motionBatch.characterBackground",
          "Character + background",
        ),
      },
    ]);
    const refHeading = this.field(
      settings,
      this.t("motionEditor.text017", "References"),
      this.refMode,
    );
    refHeading.classList.add("motion-reference-heading");
    refHeading.firstChild.prepend(this.icon("reference"));
    this.refCards = {};
    for (const kind of ["character", "background"]) {
      const card = this.element(
        "div",
        "reference-drop-zone motion-bulk-reference",
      );
      const preview = this.element(
        "span",
        `reference-preview motion-bulk-ref-preview ${kind === "character" ? "character-reference-icon" : "background-reference-icon"}`,
      );
      preview.setAttribute("aria-hidden", "true");
      const select = this.button("", () => void this.pickReference(kind));
      const summary = this.element(
        "small",
        "",
        this.t("motionEditor.text019", "Choose an image"),
      );
      const cardStatus = this.element("small", "motion-bulk-ref-status");
      cardStatus.setAttribute("role", "status");
      const remove = this.button("", () => {
        this.references[kind] = [];
        delete cardStatus.dataset.error;
        cardStatus.textContent = "";
        this.renderReference(kind);
      });
      remove.className = "motion-bulk-ref-action";
      remove.append(this.icon("delete"));
      const rescan = this.button("", () => {
        if (!this.busy && !this.uploading)
          void this.refPicker.rescan(kind, this.references);
      });
      rescan.className = "motion-bulk-ref-action motion-bulk-ref-rescan";
      rescan.append(this.icon("refresh"));
      rescan.title = this.t("motionEditor.text197", "Rescan from Flow");
      rescan.setAttribute("aria-label", rescan.title);
      const details = this.element("div", "motion-bulk-ref-details");
      details.append(
        this.element(
          "strong",
          "",
          kind === "character" ? "Character" : "Background",
        ),
        summary,
        select,
        cardStatus,
      );
      remove.setAttribute("aria-label", this.t("common.delete", "Delete"));
      card.append(preview, details, rescan, remove);
      card.addEventListener("click", (event) => {
        if (!event.target.closest("button")) void this.pickReference(kind);
      });
      card.addEventListener("dragover", (event) => {
        if (!this.busy && !this.uploading) event.preventDefault();
      });
      card.addEventListener("drop", (event) => {
        event.preventDefault();
        if (this.busy || this.uploading) return;
        const files = [...(event.dataTransfer?.files || [])];
        if (files.length !== 1) {
          cardStatus.textContent = "MOTION_REFERENCE_LIMIT_ONE";
          cardStatus.dataset.error = "true";
          return;
        }
        delete cardStatus.dataset.error;
        cardStatus.textContent = "";
        void this.refPicker
          .uploadLocal(kind, files[0], this.references)
          .catch((error) => {
            if (!this.closed) {
              cardStatus.textContent = error.message;
              cardStatus.dataset.error = "true";
            }
          });
      });
      settings.append(card);
      this.refCards[kind] = {
        card,
        preview,
        select,
        summary,
        status: cardStatus,
        remove,
        rescan,
      };
    }
    this.refMode.addEventListener("change", () => {
      this.references.mode = this.refMode.value;
      this.renderReference("background");
    });
    if (this.profile.settings.show_background_refs === false)
      this.refMode.querySelector('[value="character_background"]').disabled =
        true;
    this.agent = this.select([
      { value: "chatgpt", label: "ChatGPT" },
      { value: "gemini", label: "Gemini" },
    ]);
    this.agent.value = this.profile.settings.transcription_provider;
    this.agent.hidden = true;
    this.agent.tabIndex = -1;
    const agentRow = this.element("div", "motion-agent-picker");
    const agentLabel = this.element(
      "span",
      "motion-agent-label",
      this.t("motionEditor.text022", "Speech agent"),
    );
    agentLabel.prepend(this.icon("agent"));
    const agentChoices = this.element("div", "motion-agent-choices");
    agentChoices.setAttribute("role", "group");
    agentChoices.setAttribute("aria-label", agentLabel.textContent);
    this.agentButtons = {};
    for (const provider of ["chatgpt", "gemini"]) {
      const button = this.button("", () => {
        this.agent.value = provider;
        this.agent.dispatchEvent(new Event("change"));
      });
      button.className = "";
      button.dataset.motionAgent = provider;
      const dot = this.element("i");
      dot.setAttribute("aria-hidden", "true");
      button.append(
        dot,
        this.icon(provider),
        document.createTextNode(provider === "chatgpt" ? "ChatGPT" : "Gemini"),
      );
      agentChoices.append(button);
      this.agentButtons[provider] = button;
    }
    agentRow.append(agentLabel, agentChoices, this.agent);
    settings.append(agentRow);
    this.agentStatus = this.element("small", "motion-bulk-agent-status");
    this.agentStatus.hidden = true;
    this.agentStatus.setAttribute("role", "status");
    settings.append(this.agentStatus);
    const toggle = (key, fallback, hintKey, hint, icon) => {
      const input = this.element("input");
      input.type = "checkbox";
      input.setAttribute("role", "switch");
      input.setAttribute("aria-label", this.t(key, fallback));
      const row = this.element("label", "setting-toggle");
      const text = this.element("span");
      const label = this.element(
        "strong",
        "motion-toggle-label",
        this.t(key, fallback),
      );
      label.prepend(this.icon(icon));
      text.append(label, this.element("small", "", this.t(hintKey, hint)));
      row.append(text, input);
      settings.append(row);
      return input;
    };
    this.voice = toggle(
      "motionEditor.text025",
      "Sync dialogue",
      "motionEditor.text026",
      "Ask Flow to generate a new voice",
      "voice",
    );
    this.subtitle = toggle(
      "motionEditor.text027",
      "Show subtitles",
      "motionEditor.text028",
      "Ask Flow to draw text",
      "subtitle",
    );
    this.translate = toggle(
      "motionEditor.text029",
      "Translate dialogue",
      "motionEditor.text030",
      "Use the translation for voice/subtitles",
      "language",
    );
    this.allLanguages = this.languageOptions();
    this.language = this.select(this.allLanguages);
    this.languageRow = this.field(
      settings,
      this.t("motionEditor.text031", "Target language"),
      this.language,
      "div",
    );
    this.languageRow.firstChild.id = `motion-bulk-${this.bulkCreateId}-language-label`;
    this.initLanguagePicker();
    this.voiceMode = this.select([
      {
        value: "lip_sync",
        label: this.t("motionEditor.voiceModeLipSync", "Lip-sync"),
      },
      {
        value: "character",
        label: this.t("motionEditor.voiceModeNormal", "Normal dialogue"),
      },
      {
        value: "narration",
        label: this.t(
          "motionEditor.voiceModeNarration",
          "Off-screen narration",
        ),
      },
    ]);
    this.voiceModeRow = this.field(
      settings,
      this.t("motionEditor.voiceMode", "Voice mode"),
      this.voiceMode,
    );
    this.voiceModeRow.firstChild.prepend(this.icon("speech"));
    this.voiceSlug = null;
    this.voiceButton = this.button("", () => this.pickVoice());
    this.voiceButton.classList.add("motion-voice-trigger");
    this.voiceLabel = this.element(
      "span",
      "motion-bulk-voice-label",
      this.t("motionEditor.text033", "Random voice"),
    );
    this.voiceButton.append(
      this.icon("voice"),
      this.voiceLabel,
      this.icon("arrow"),
    );
    this.voiceRow = this.field(
      settings,
      this.t("motionEditor.text032", "Flow voice"),
      this.voiceButton,
      "div",
    );
    this.voiceRow.firstChild.id = `motion-bulk-${this.bulkCreateId}-voice-label`;
    this.voiceButton.setAttribute(
      "aria-labelledby",
      this.voiceRow.firstChild.id,
    );
    this.voiceRow.firstChild.prepend(this.icon("flow"));
    const speechRow = this.element(
      "div",
      "motion-field-row motion-speech-fields",
    );
    this.voiceModeRow.before(speechRow);
    speechRow.append(this.voiceModeRow, this.voiceRow);
    this.voiceDescription = this.element("textarea");
    this.voiceDescription.maxLength = 500;
    this.voiceDescription.rows = 2;
    this.voiceDescription.placeholder = this.t(
      "motionEditor.voiceDescriptionPlaceholder",
      "Voice, rhythm, emotion\u2026",
    );
    this.voiceDescriptionRow = this.field(
      settings,
      this.t("motionEditor.text034", "Voice description"),
      this.voiceDescription,
    );
    this.voiceDescriptionRow.firstChild.prepend(this.icon("user-voice"));
    this.autoDownload = toggle(
      "motionEditor.text036",
      "Auto download final video",
      "motionEditor.text037",
      "Download after merging finishes",
      "download",
    );
    for (const input of [this.voice, this.subtitle, this.translate, this.agent])
      input.addEventListener("change", () => {
        this.renderVisibility();
        void this.refreshAgent();
      });
    body.append(videoArea, settings);
    const footer = this.element("footer", "motion-bulk-footer");
    this.status = this.element("span", "motion-bulk-status");
    this.status.setAttribute("role", "status");
    const cancel = this.button(this.t("common.cancel", "Cancel"), () =>
      this.close(),
    );
    this.create = this.button(
      this.t("common.create", "Create"),
      () => void this.submit(),
    );
    this.create.className = "btn btn-primary";
    this.creationOverlay = this.element("div", "motion-bulk-creation-overlay");
    this.creationOverlay.hidden = true;
    const progressStatus = this.element("div", "motion-bulk-creation-status");
    progressStatus.setAttribute("role", "status");
    progressStatus.setAttribute("aria-live", "polite");
    progressStatus.setAttribute("aria-atomic", "true");
    const spinner = this.element("span", "motion-bulk-creation-spinner");
    spinner.setAttribute("aria-hidden", "true");
    this.creationProgress = this.element("strong");
    progressStatus.append(
      spinner,
      this.element("span", "", this.t("project.creating", "Creating\u2026")),
      this.creationProgress,
    );
    progressStatus.tabIndex = -1;
    this.creationOverlay.append(
      progressStatus,
      this.button(this.t("common.cancel", "Cancel"), () => this.close()),
    );
    this.creationContent = [header, body, footer];
    this.panel = panel;
    this.progressStatus = progressStatus;
    footer.append(this.status, cancel, this.create);
    panel.append(header, body, footer, this.creationOverlay);
    this.root.append(panel);
    document.body.append(this.root, this.languageDialog);
    this.videoPicker = new MotionBulkVideoPicker({
      host: videoArea,
      maxBytes: window.videoSplitTool.constructor.MAX_SOURCE_BYTES,
      text: (key) =>
        ({
          drop: this.t("videoSplit.drop", "Drop videos here"),
          choose: this.t("videoSplit.choose", "Choose videos"),
          close: this.t("common.close", "Close"),
          remove: this.t("common.delete", "Delete"),
          play: this.t("videoSplit.preview", "Preview"),
          invalid: this.t("videoSplit.duration", "Invalid video"),
          quota: this.t("motionBatch.quota", "Projects"),
          thumbnailUnavailable: this.t(
            "motionBatch.thumbnailUnavailable",
            "Thumbnail unavailable",
          ),
          remaining: this.t("motionBatch.remaining", "Remaining"),
          overLimit: this.t("motionBatch.overLimit", "Exceeds project limit"),
        })[key] || key,
      onChange: (values) => {
        const next = new Set(values.map((item) => item.itemId));
        for (const itemId of this.selectedIds)
          if (!next.has(itemId)) {
            MotionArtifactStore.deleteUnstartedBulkJournalItem({
              userId: this.userId,
              bulkCreateId: this.bulkCreateId,
              itemId,
            }).catch((error) =>
              console.warn("[MotionBulk] Retained journal:", error?.message),
            );
          }
        this.selectedIds = next;
        this.updateButtons();
      },
    });
    this.videoPicker.setQuota(this.quota);
    this.refPicker = new MotionBulkReferencePicker({
      userId: this.userId,
      flowProjectId: this.flowProjectId,
      profile: this.profile,
      onChange: (kind, refs) => {
        this.references[kind] = refs;
        this.renderReference(kind);
      },
      onBusy: (kind, busy, operation) => {
        this.uploading = busy;
        this.refCards[kind].card.classList.toggle("is-uploading", busy);
        this.refCards[kind].card.setAttribute("aria-busy", String(busy));
        const status = this.refCards[kind].status;
        if (busy) clearTimeout(status.hideTimer);
        if (busy) {
          delete status.dataset.error;
          status.textContent =
            operation === "rescan"
              ? this.t("motionEditor.text197", "Rescan from Flow")
              : this.t("videoSplit.uploading", "Uploading\u2026");
        } else if (!status.dataset.error) status.textContent = "";
        this.updateButtons();
      },
      onError: (message, kind) => {
        const status = this.refCards[kind]?.status || this.status;
        status.textContent = message;
        status.dataset.error = "true";
      },
      onStatus: (kind, found) => {
        const status = this.refCards[kind].status;
        status.textContent = found
          ? this.t("motionEditor.text129", "Flow thumbnail updated.")
          : this.t("motionEditor.text128", "Thumbnail not found in Flow.");
        status.dataset.error = String(!found);
        clearTimeout(status.hideTimer);
        status.hideTimer = setTimeout(() => {
          status.textContent = "";
        }, 5e3);
      },
    });
    try {
      if (this.resumeItems.length) {
        await this.restorePending();
        if (this.closed) return;
        const ids = this.videoPicker.values().map((item) => item.itemId);
        if (ids.length) {
          const admission = await MotionBulkCreator.checkBatchAdmission({
            userId: this.userId,
            bulkCreateId: this.bulkCreateId,
            flowProjectId: this.flowProjectId,
            itemIds: ids,
          });
          if (this.closed) return;
          this.videoPicker.setQuota(admission);
        }
      }
    } catch (error) {
      this.refPicker.close();
      this.videoPicker.destroy();
      this.root.remove();
      throw error;
    }
    this.renderReference("character");
    this.renderReference("background");
    this.renderVisibility();
    this.updateButtons();
    this.keyHandler = (event) => {
      if (
        this.videoPicker.preview.open ||
        this.languageDialog.open ||
        window.imagePickerModal?.overlay ||
        window.VoiceSelectModal?._overlay?.classList?.contains("visible")
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      }
      if (event.key === "Tab") {
        const controls = [
          ...this.root.querySelectorAll(
            "button, input, select, textarea, [tabindex]",
          ),
        ].filter(
          (node) =>
            !node.disabled &&
            node.tabIndex >= 0 &&
            !node.closest("[hidden], [inert]"),
        );
        const current = controls.indexOf(document.activeElement);
        if (
          controls.length &&
          (current < 0 ||
            (event.shiftKey ? current === 0 : current === controls.length - 1))
        ) {
          event.preventDefault();
          (event.shiftKey ? controls.at(-1) : controls[0]).focus();
        }
      }
    };
    document.addEventListener("keydown", this.keyHandler);
    const closeIfScopeChanged = () => {
      try {
        MotionBulkCreator._context(this.userId, this.flowProjectId);
      } catch (_) {
        this.close();
      }
    };
    this.scopeOffs = [
      window.eventBus?.on?.("project:changed", closeIfScopeChanged),
      window.eventBus?.on?.("auth:login", closeIfScopeChanged),
      window.eventBus?.on?.("auth:logout", () => this.close()),
      window.eventBus?.on?.("sse:tool_config_updated", (data) => {
        if (data?.tool_key === "motion_studio")
          void this.refreshVoiceVisibility();
      }),
    ].filter((off) => typeof off === "function");
    this.healthTimer = setInterval(() => void this.refreshAgent(), 1e4);
    void this.refreshAgent();
    close.focus();
  }
  async restorePending() {
    const first = this.resumeItems[0];
    if (
      this.resumeItems.some(
        (item) =>
          item.userId !== Number(this.userId) ||
          item.bulkCreateId !== this.bulkCreateId ||
          item.flowProjectId !== this.flowProjectId ||
          JSON.stringify(item.settings) !== JSON.stringify(first.settings),
      )
    ) {
      throw new Error("MOTION_BULK_JOURNAL_MISMATCH");
    }
    const settings = first.settings;
    this.ratio.value = settings.ratio || "";
    this.renderRatioPicker();
    this.resolution.value = settings.flow_download_resolution || "";
    if (!this.ratio.value || !this.resolution.value)
      throw new Error("MOTION_BULK_SETTINGS_UNAVAILABLE");
    this.references = structuredClone(settings.references || this.references);
    this.refMode.value = this.references.mode;
    this.agent.value = settings.transcription_provider || "";
    this.voice.checked = settings.voice_enabled === true;
    this.subtitle.checked = settings.subtitle_enabled === true;
    this.translate.checked = settings.translate_enabled === true;
    this.language.value = settings.target_language || "";
    this.renderLanguageTrigger();
    this.voiceMode.value = settings.voice_mode || "character";
    this.voiceSlug = settings.voice_slug || null;
    if (this.voiceSlug) {
      const voice = window.VoiceRegistry?.findBySlug?.(this.voiceSlug);
      this.voiceLabel.textContent = voice?.display_name || this.voiceSlug;
    }
    this.voiceDescription.value = settings.voice_description || "";
    this.autoDownload.checked = settings.auto_download_final === true;
    if (this.translate.checked && !this.language.value)
      throw new Error("MOTION_BULK_SETTINGS_UNAVAILABLE");
    for (const item of this.resumeItems) {
      MotionBulkCreator._context(this.userId, this.flowProjectId);
      const source = await MotionArtifactStore.getBulkSource({
        userId: this.userId,
        bulkCreateId: this.bulkCreateId,
        itemId: item.itemId,
      });
      if (this.closed) return;
      MotionBulkCreator._context(this.userId, this.flowProjectId);
      if (!source?.blob || source.flowProjectId !== this.flowProjectId) {
        if (item.stage === "selected" && !source) {
          await MotionArtifactStore.deleteUnstartedBulkJournalItem({
            userId: this.userId,
            bulkCreateId: this.bulkCreateId,
            itemId: item.itemId,
          });
          if (this.closed) return;
          MotionBulkCreator._context(this.userId, this.flowProjectId);
        } else this.recoveryBlocked = true;
        this.status.textContent = this.t(
          "motionBatchRecovery.missingSource",
          "A video must be selected again.",
        );
        continue;
      }
      this.videoPicker.restore({
        itemId: item.itemId,
        blob: source.blob,
        fileName: source.fileName,
      });
      await this.videoPicker.queue;
      if (this.closed) return;
      MotionBulkCreator._context(this.userId, this.flowProjectId);
      this.videoPicker.releaseFile(item.itemId, () =>
        this.loadStagedSource(item.itemId),
      );
    }
  }
  async loadStagedSource(itemId) {
    MotionBulkCreator._context(this.userId, this.flowProjectId);
    const source = await MotionArtifactStore.getBulkSource({
      userId: this.userId,
      bulkCreateId: this.bulkCreateId,
      itemId,
    });
    MotionBulkCreator._context(this.userId, this.flowProjectId);
    if (
      this.closed ||
      source?.flowProjectId !== this.flowProjectId ||
      !source?.blob
    ) {
      throw new Error("MOTION_BULK_SOURCE_MISMATCH");
    }
    return source.blob;
  }
  renderReference(kind) {
    const card = this.refCards[kind];
    const ref = this.references[kind]?.[0];
    card.card.hidden =
      kind === "background" && this.references.mode !== "character_background";
    card.summary.textContent =
      ref?.display_name ||
      ref?.file_name ||
      ref?.fileId ||
      this.t("motionEditor.text019", "Choose an image");
    card.preview.replaceChildren();
    if (ref?.thumbnail) {
      const img = this.element("img");
      img.alt = "";
      img.src = ref.thumbnail;
      card.preview.append(img);
    }
    card.select.textContent =
      kind === "character"
        ? this.t("motionEditor.text020", "Choose / replace character image")
        : this.t("motionEditor.text021", "Choose / replace background image");
    card.select.prepend(
      this.icon(kind === "character" ? "character" : "background"),
    );
    card.remove.disabled = !ref || this.busy || this.uploading;
    card.rescan.disabled = !ref || this.busy || this.uploading;
  }
  async pickReference(kind) {
    if (this.busy || this.uploading) return;
    const status = this.refCards[kind].status;
    delete status.dataset.error;
    status.textContent = "";
    try {
      await this.refPicker.open(kind, this.references);
    } catch (error) {
      if (!this.closed) {
        status.textContent = error.message;
        status.dataset.error = "true";
      }
    }
  }
  pickVoice() {
    if (
      !this.showFlowVoice ||
      !this.voice.checked ||
      this.busy ||
      this.uploading ||
      !window.VoiceSelectModal ||
      !window.VoiceRegistry
    )
      return;
    window.VoiceSelectModal.show({
      voices: window.VoiceRegistry.getRenderListSync("flow"),
      selectedSlug: this.voiceSlug,
      onSelect: (voice) => {
        this.voiceSlug = voice?.slug || null;
        this.voiceLabel.textContent =
          voice?.display_name || this.t("motionEditor.text033", "Random voice");
      },
    });
  }
  renderVisibility() {
    for (const [provider, button] of Object.entries(this.agentButtons))
      button.setAttribute(
        "aria-pressed",
        String(provider === this.agent.value),
      );
    const enabled = this.voice.checked || this.subtitle.checked;
    if (!enabled) {
      clearTimeout(this.agentStatusTimer);
      this.lastAgentStatus = null;
      this.agentStatus.hidden = true;
      this.agentStatus.textContent = "";
    }
    this.translate.disabled = !enabled;
    if (!enabled) this.translate.checked = false;
    this.languageRow.hidden = !this.translate.checked;
    this.voiceModeRow.hidden = this.voiceDescriptionRow.hidden =
      !this.voice.checked;
    this.voiceRow.hidden = !this.voice.checked || !this.showFlowVoice;
    this.voiceButton.disabled = !this.voice.checked || !this.showFlowVoice;
    this.voiceRow.parentElement.classList.toggle(
      "is-single-field",
      !this.showFlowVoice,
    );
  }
  async refreshVoiceVisibility() {
    const epoch = (this.voiceVisibilityEpoch =
      (this.voiceVisibilityEpoch || 0) + 1);
    try {
      MotionBulkCreator._context(this.userId, this.flowProjectId);
      const response = await window.RequestSigner.fetchProtected("motionTool", {
        force: true,
        promptVariant: "timeline",
      });
      if (
        this.closed ||
        epoch !== this.voiceVisibilityEpoch ||
        response?.data?.tool_key !== "motion_studio"
      )
        return;
      MotionBulkCreator._context(this.userId, this.flowProjectId);
      this.showFlowVoice = response.data.settings?.show_flow_voice !== false;
      this.renderVisibility();
    } catch (error) {
      if (!this.closed)
        console.warn("[MotionBulk] Voice visibility refresh failed", {
          code: error?.code || "CONFIG_UNAVAILABLE",
        });
    }
  }
  showAgentStatus(agent, ready, key, fallback) {
    if (this.closed || !(this.voice.checked || this.subtitle.checked)) return;
    const signature = `${agent}:${ready}:${key}`;
    if (signature === this.lastAgentStatus) return;
    this.lastAgentStatus = signature;
    clearTimeout(this.agentStatusTimer);
    this.agentStatus.dataset.ready = String(ready);
    this.agentStatus.textContent = this.t(key, fallback);
    this.agentStatus.hidden = false;
    this.agentStatusTimer = setTimeout(() => {
      this.agentStatusTimer = null;
      this.agentStatus.hidden = true;
      this.agentStatus.textContent = "";
    }, 5e3);
  }
  async refreshAgent() {
    if (
      this.closed ||
      this.healthFlight ||
      !(this.voice.checked || this.subtitle.checked)
    )
      return;
    const agent = this.agent.value;
    this.healthFlight = true;
    try {
      const result = await chrome.runtime.sendMessage({
        action: "i2p:checkProviders",
        excludeWorkerTabs:
          this.profile?.settings?.execution_mode === "parallel",
      });
      if (!this.closed) {
        for (const [provider, button] of Object.entries(this.agentButtons))
          button.classList.toggle(
            "is-ready",
            result?.providers?.[provider]?.ready === true,
          );
        if (this.agent.value === agent) {
          const state = result?.providers?.[agent],
            ready = state?.ready === true;
          this.showAgentStatus(
            agent,
            ready,
            ready
              ? "motionEditor.text007"
              : state?.tabOpen
                ? "motionEditor.text181"
                : "motionEditor.text182",
            ready
              ? "Ready"
              : state?.tabOpen
                ? "Sign in / check the provider page"
                : "Provider page is not open",
          );
        }
      }
    } catch (_) {
      if (!this.closed && this.agent.value === agent) {
        this.agentButtons[agent].classList.remove("is-ready");
        this.showAgentStatus(agent, false, "motionEditor.text146", "Not ready");
      }
    } finally {
      this.healthFlight = false;
    }
  }
  updateButtons() {
    if (!this.create) return;
    const values = this.videoPicker?.values() || [];
    this.create.disabled =
      this.busy ||
      this.uploading ||
      this.recoveryBlocked === true ||
      !values.length ||
      values.some((item) => item.state !== "ready");
    this.panel.classList.toggle("is-creating", this.busy);
    this.creationOverlay.hidden = !this.busy;
    for (const content of this.creationContent) content.inert = this.busy;
    this.settingsPanel.inert = this.busy || this.uploading;
    this.videoArea.inert = this.busy;
    for (const kind of ["character", "background"]) {
      const card = this.refCards[kind];
      card.remove.disabled = card.rescan.disabled =
        !this.references[kind]?.length || this.busy || this.uploading;
    }
  }
  snapshot() {
    return {
      ratio: this.ratio.value,
      flow_download_resolution: this.resolution.value,
      references: structuredClone(this.references),
      transcription_provider: this.agent.value,
      voice_enabled: this.voice.checked,
      voice_mode: this.voiceMode.value,
      subtitle_enabled: this.subtitle.checked,
      translate_enabled: this.translate.checked,
      target_language: this.translate.checked
        ? this.language.value.trim()
        : null,
      voice_slug: this.voice.checked ? this.voiceSlug : null,
      voice_description: this.voice.checked
        ? this.voiceDescription.value.trim()
        : null,
      auto_download_final: this.autoDownload.checked,
    };
  }
  validateSettings(settings) {
    MotionBulkCreator._context(this.userId, this.flowProjectId);
    const pcm = window.ProviderConfigManager;
    if (
      !pcm.getRatiosSync("flow", "video")?.map((r) => (typeof r === "string" ? r : r?.value))?.includes(settings.ratio) ||
      !pcm
        .getDownloadResolutionsSync("flow")
        ?.video?.some(
          (option) => option.value === settings.flow_download_resolution,
        ) ||
      !["chatgpt", "gemini"].includes(settings.transcription_provider) ||
      !["character", "lip_sync", "narration"].includes(settings.voice_mode)
    )
      throw new Error("MOTION_BULK_SETTINGS_UNAVAILABLE");
    const refs = settings.references;
    if (
      !["character_only", "character_background"].includes(refs?.mode) ||
      (refs.mode === "character_background" &&
        this.profile.settings.show_background_refs === false) ||
      ["character", "background"].some(
        (kind) => !Array.isArray(refs[kind]) || refs[kind].length > 1,
      )
    )
      throw new Error("MOTION_BULK_SETTINGS_UNAVAILABLE");
    const used = [
      ...refs.character,
      ...(refs.mode === "character_background" ? refs.background : []),
    ];
    if (
      [...refs.character, ...refs.background].some(
        (ref) =>
          !ref?.fileId ||
          ref.fileId.startsWith("upload_") ||
          ref.project_id !== this.flowProjectId,
      )
    )
      throw new Error("MOTION_REF_PROJECT_MISMATCH");
    const caps = window.ImagePickerModal.resolveCapsMulti({
      provider: "flow",
      mode: "video",
      isFrames: false,
      modelValue: this.profile.settings.flow_model,
      duration: this.profile.settings.flow_duration,
    });
    if (!Number.isInteger(caps?.image) || !Number.isInteger(caps?.video))
      throw new Error("MOTION_REF_CAP_CONFIG_UNAVAILABLE");
    if (
      used.length &&
      (caps.video < 1 ||
        used.length > caps.image ||
        (Number.isInteger(caps.total) && used.length + 1 > caps.total))
    )
      throw (
        window.ImagePickerModal.motionReferenceCapError?.({
          caps,
          imageCount: used.length,
          stage: "prepare",
          modelValue: this.profile.settings.flow_model,
        }) || new Error("MOTION_REF_CAP_EXCEEDED")
      );
  }
  async submit() {
    if (this.busy || this.uploading || this.closed || this.recoveryBlocked)
      return;
    const values = this.videoPicker.values();
    const settings = this.snapshot();
    if (!values.length || values.some((item) => item.state !== "ready")) return;
    if (settings.translate_enabled && !settings.target_language) {
      this.status.textContent = this.t(
        "motionEditor.text116",
        "Choose a target language.",
      );
      return;
    }
    const completedItems = new Set();
    const updateProgress = () => {
      this.creationProgress.textContent = `${completedItems.size}/${values.length} ${this.t("motionBatch.quota", "Projects")}`;
    };
    updateProgress();
    this.busy = true;
    this.updateButtons();
    this.progressStatus.focus();
    try {
      this.validateSettings(settings);
      const quota = await MotionBulkCreator.checkQuota({
        userId: this.userId,
        flowProjectId: this.flowProjectId,
        count: 0,
      });
      if (this.closed) return;
      this.videoPicker.setQuota(quota);
      for (const item of values) {
        if (this.closed) return;
        const identity = {
          userId: this.userId,
          bulkCreateId: this.bulkCreateId,
          itemId: item.itemId,
        };
        const existing = await MotionArtifactStore.getBulkJournalItem(identity);
        if (this.closed) return;
        if (existing) {
          if (
            existing.flowProjectId !== this.flowProjectId ||
            existing.fileName !== item.fileName ||
            JSON.stringify(existing.settings) !== JSON.stringify(settings)
          )
            throw new Error("MOTION_BULK_SETTINGS_CONFLICT");
          continue;
        }
        await MotionArtifactStore.createBulkJournalItem({
          ...identity,
          flowProjectId: this.flowProjectId,
          fileName: item.fileName,
          settings,
          duration: item.duration,
        });
      }
      if (this.closed) return;
      const admission = await MotionBulkCreator.checkBatchAdmission({
        userId: this.userId,
        bulkCreateId: this.bulkCreateId,
        flowProjectId: this.flowProjectId,
        itemIds: values.map((item) => item.itemId),
      });
      if (this.closed) return;
      this.videoPicker.setQuota(admission);
      if (!admission.planAllowed) throw new Error("MOTION_BULK_PLAN_REQUIRED");
      if (!admission.allowed) {
        await window.customDialog?.alert?.(
          this.t(
            "motionBatch.quotaExceeded",
            "Selected videos exceed the available project slots.",
          ),
          {
            title: this.t("motionBatch.createTitle", "Create Motion projects"),
            type: "warning",
          },
        );
        return;
      }
      const result = await MotionBulkCreator.processItems({
        userId: this.userId,
        bulkCreateId: this.bulkCreateId,
        items: values.map((item) => ({ itemId: item.itemId, blob: item.file })),
        shouldStop: () => this.closed,
        onItem: (item) => {
          if (item.stage === "staged") {
            const selected = values.find(
              (value) => value.itemId === item.itemId,
            );
            if (selected) selected.file = null;
            if (!this.closed)
              this.videoPicker.releaseFile(item.itemId, () =>
                this.loadStagedSource(item.itemId),
              );
          }
          if (!this.closed) {
            if (
              item.status === "complete" &&
              values.some((value) => value.itemId === item.itemId)
            )
              completedItems.add(item.itemId);
            updateProgress();
            const name =
              values.find((value) => value.itemId === item.itemId)?.fileName ||
              "";
            const label =
              item.status === "complete"
                ? this.t("motionBatch.created", "Projects created")
                : item.status === "failed"
                  ? item.code
                  : this.t("videoSplit.working", "Processing");
            this.status.textContent = `${label} \xB7 ${name}`;
          }
        },
      });
      if (!this.closed)
        this.status.textContent =
          result.status === "complete"
            ? this.t("motionBatch.created", "Projects created")
            : `${result.code || result.status} \xB7 ${values.find((item) => item.itemId === result.failedItemId)?.fileName || ""}`;
      if (result.status === "complete" && !this.closed) {
        MotionBulkCreator._context(this.userId, this.flowProjectId);
        this.close();
        window.showNotification?.(
          `${this.t("motionBatch.created", "Projects created")} \xB7 ${result.results?.length ?? values.length}`,
          "success",
        );
      }
      try {
        await this.onDone(result);
      } catch (_) {
        console.warn("[MotionBulk] Project list refresh pending");
      }
    } catch (error) {
      if (!this.closed) this.status.textContent = error.message;
    } finally {
      this.busy = false;
      if (!this.closed) {
        this.updateButtons();
        this.create.focus();
      } else await this.clearBatch();
    }
  }
  clearBatch() {
    this.cleanupPromise = (this.cleanupPromise || Promise.resolve())
      .then(() =>
        MotionBulkCreator.discardBatch({
          userId: this.userId,
          bulkCreateId: this.bulkCreateId,
        }),
      )
      .catch((error) =>
        console.warn("[MotionBulk] Modal cleanup pending", {
          code: error?.message,
        }),
      );
    return this.cleanupPromise;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.healthTimer);
    clearTimeout(this.agentStatusTimer);
    this.refPicker?.close();
    this.videoPicker?.destroy();
    void this.clearBatch().finally(() => {
      this.releaseBatchLock?.();
      this.releaseBatchLock = null;
    });
    if (this.languageDialog?.open) this.languageDialog.close();
    this.languageDialog?.remove();
    for (const card of Object.values(this.refCards || {}))
      clearTimeout(card.status.hideTimer);
    for (const off of this.scopeOffs || []) off();
    this.scopeOffs = [];
    document.removeEventListener("keydown", this.keyHandler);
    this.root?.remove();
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
    this.previousFocus = null;
  }
};
__publicField(_MotionBulkModal, "languageCache", new Map());
let MotionBulkModal = _MotionBulkModal;
globalThis.MotionBulkModal = MotionBulkModal;
