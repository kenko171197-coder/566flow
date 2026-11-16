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
const _MentionMenu = class _MentionMenu {
  constructor(textarea, cfg) {
    this.textarea = textarea;
    this.cfg = cfg || {};
    this.el = null;
    this.visible = false;
    this.tabs = [];
    this.activeTabId = null;
    this.items = [];
    this.activeIndex = -1;
    this.query = "";
    this.atPos = -1;
    this._failedThumbnails = new Set();
    this._boundInput = () => this._onInput();
    this._boundKeydown = (e) => this._onKeydown(e);
    this._boundBlur = () =>
      setTimeout(() => {
        if (!this.el?.contains(document.activeElement)) this.hide();
      }, 150);
    textarea.addEventListener("input", this._boundInput);
    textarea.addEventListener("keydown", this._boundKeydown, true);
    textarea.addEventListener("blur", this._boundBlur);
  }
  destroy() {
    this.textarea.removeEventListener("input", this._boundInput);
    this.textarea.removeEventListener("keydown", this._boundKeydown, true);
    this.textarea.removeEventListener("blur", this._boundBlur);
    this.el?.remove();
    this.el = null;
  }
  _detect() {
    const ta = this.textarea;
    const cursor = ta.selectionStart;
    if (cursor !== ta.selectionEnd) return null;
    const before = ta.value.slice(0, cursor);
    const m = before.match(
      /(^|[^A-Za-z0-9_@])@(voice:|char:)?(\[[^\]]*|[^\s@]*)$/,
    );
    if (!m) return null;
    const ns = m[2] ? (m[2] === "voice:" ? "voice" : "char") : null;
    let q = m[3] || "";
    if (q.startsWith("[")) q = q.slice(1);
    return { atPos: m.index + m[1].length, cursor, ns, query: q };
  }
  _onInput() {
    const hit = this._detect();
    if (!hit) {
      this.hide();
      return;
    }
    const tabs = (this.cfg.getTabs?.() || []).filter(
      (t) => t && (t.visible === void 0 || t.visible),
    );
    if (tabs.length === 0) {
      this.hide();
      return;
    }
    this.tabs = tabs;
    this.atPos = hit.atPos;
    this.query = hit.query;
    if (hit.ns && tabs.some((t) => t.id === hit.ns)) {
      this.activeTabId = hit.ns;
    } else if (
      !this.activeTabId ||
      !tabs.some((t) => t.id === this.activeTabId)
    ) {
      const def = this.cfg.defaultTabId?.();
      this.activeTabId = tabs.some((t) => t.id === def) ? def : tabs[0].id;
    }
    this._render();
  }
  _onKeydown(e) {
    if (!this.visible) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        e.stopPropagation();
        {
          const next = this.items.findIndex(
            (item, index) => index > this.activeIndex && !item.disabled,
          );
          if (next >= 0) this.activeIndex = next;
        }
        this._renderItems();
        break;
      case "ArrowUp":
        e.preventDefault();
        e.stopPropagation();
        {
          const previous = this.items.reduce(
            (last, item, index) =>
              index < this.activeIndex && !item.disabled ? index : last,
            -1,
          );
          if (previous >= 0) this.activeIndex = previous;
        }
        this._renderItems();
        break;
      case "Tab": {
        e.preventDefault();
        e.stopPropagation();
        const idx = this.tabs.findIndex((t) => t.id === this.activeTabId);
        const next = e.shiftKey
          ? (idx - 1 + this.tabs.length) % this.tabs.length
          : (idx + 1) % this.tabs.length;
        this.activeTabId = this.tabs[next].id;
        this._render();
        break;
      }
      case "Enter":
        if (
          this.activeIndex >= 0 &&
          this.items[this.activeIndex] &&
          !this.items[this.activeIndex].disabled
        ) {
          e.preventDefault();
          e.stopPropagation();
          this._insert(this.items[this.activeIndex]);
        }
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        this.hide();
        break;
    }
  }
  hide() {
    if (this.el) this.el.style.display = "none";
    this.visible = false;
    this.activeIndex = -1;
  }
  _ensureEl() {
    if (this.el) return this.el;
    this.el = document.createElement("div");
    this.el.className = "mention-menu";
    this.el.style.display = "none";
    document.body.appendChild(this.el);
    this.el.addEventListener("mousedown", (e) => {
      const tabBtn = e.target.closest(".mention-menu-tab");
      if (tabBtn) {
        e.preventDefault();
        this.activeTabId = tabBtn.dataset.tabId;
        this._render();
        return;
      }
      const itemEl = e.target.closest(".mention-menu-item");
      if (itemEl) {
        e.preventDefault();
        const idx = parseInt(itemEl.dataset.index, 10);
        if (this.items[idx]) this._insert(this.items[idx]);
      }
    });
    this.el.addEventListener(
      "error",
      (e) => {
        const img = e.target;
        if (!img?.classList?.contains("mention-menu-item-thumb")) return;
        this._failedThumbnails.add(img.getAttribute("src"));
        const index = Number(img.closest(".mention-menu-item")?.dataset.index);
        const fallback = document.createElement("span");
        fallback.className = "mention-menu-item-icon";
        fallback.innerHTML = this.items[index]?.iconSvg || "";
        img.replaceWith(fallback);
      },
      true,
    );
    return this.el;
  }
  _esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  _render() {
    const el = this._ensureEl();
    const activeTab =
      this.tabs.find((t) => t.id === this.activeTabId) || this.tabs[0];
    this.activeTabId = activeTab.id;
    const q = this.query.toLowerCase();
    let items = [];
    try {
      items = activeTab.getItems() || [];
    } catch (error) {
      console.warn("[MentionMenu] Cannot read items", {
        tabId: activeTab.id,
        message: error?.message,
      });
      items = [];
    }
    if (q) {
      items = items.filter(
        (it) =>
          String(it.label || "")
            .toLowerCase()
            .includes(q) ||
          String(it.sublabel || "")
            .toLowerCase()
            .includes(q),
      );
    }
    this.items = items.slice(0, 50);
    const budget = this.tabs.some((tab) => tab.id === "ref")
      ? this.cfg.getRefBudget?.({
          text: this.textarea.value,
          cursor: this.textarea.selectionStart,
          atPos: this.atPos,
          items: this.items,
        })
      : null;
    if (budget && activeTab.id === "ref")
      this.items = this.items.map((item) => ({
        ...item,
        alreadyUsed: budget.isSelected(item),
        disabled: !budget.canAdd(item),
      }));
    this.activeIndex = this.items.findIndex((item) => !item.disabled);
    const tabsHtml = this.tabs
      .map(
        (t) => `
      <button type="button" class="mention-menu-tab${t.id === this.activeTabId ? " active" : ""}" data-tab-id="${this._esc(t.id)}">
        ${t.iconSvg || ""}<span>${this._esc(t.label)}</span>${t.id === "ref" && budget ? `<span class="mention-menu-count">${budget.used}${budget.max == null ? "" : `/${budget.max}`}</span>` : ""}
      </button>`,
      )
      .join("");
    el.innerHTML = `<div class="mention-menu-tabs">${tabsHtml}</div><div class="mention-menu-list"></div>`;
    this._renderItems();
    el.style.display = "block";
    this.visible = true;
    this._position();
  }
  _renderItems() {
    const list = this.el?.querySelector(".mention-menu-list");
    if (!list) return;
    if (this.items.length === 0) {
      list.innerHTML = `<div class="mention-menu-empty">${this._esc(window.I18n?.t?.("mention.noResults") || "No results")}</div>`;
      return;
    }
    list.innerHTML = this.items
      .map((it, idx) => {
        const thumb =
          it.thumbnail && !this._failedThumbnails.has(it.thumbnail)
            ? `<img class="mention-menu-item-thumb" src="${this._esc(it.thumbnail)}" alt="">`
            : `<span class="mention-menu-item-icon">${it.iconSvg || ""}</span>`;
        return `
        <div class="mention-menu-item${idx === this.activeIndex ? " active" : ""}${it.disabled ? " disabled" : ""}" data-index="${idx}"${it.disabled ? ' aria-disabled="true"' : ""}>
          ${thumb}
          <span class="mention-menu-item-label">${this._esc(it.label)}</span>
          ${it.sublabel ? `<span class="mention-menu-item-sub">${this._esc(it.sublabel)}</span>` : ""}
          ${it.alreadyUsed ? '<span class="mention-menu-item-used" aria-hidden="true">\u2713</span>' : ""}
        </div>`;
      })
      .join("");
    list
      .querySelector(".mention-menu-item.active")
      ?.scrollIntoView({ block: "nearest" });
  }
  _caretCoords() {
    const ta = this.textarea;
    const rect = ta.getBoundingClientRect();
    const style = window.getComputedStyle(ta);
    const lineHeight =
      parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 || 16;
    const mirror = document.createElement("div");
    const props = [
      "boxSizing",
      "width",
      "borderTopWidth",
      "borderRightWidth",
      "borderBottomWidth",
      "borderLeftWidth",
      "borderStyle",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "fontStyle",
      "fontVariant",
      "fontWeight",
      "fontSize",
      "lineHeight",
      "fontFamily",
      "textAlign",
      "textTransform",
      "textIndent",
      "letterSpacing",
      "wordSpacing",
      "tabSize",
    ];
    for (const p of props) {
      try {
        mirror.style[p] = style[p];
      } catch (_) {}
    }
    mirror.style.position = "absolute";
    mirror.style.visibility = "hidden";
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.wordWrap = "break-word";
    mirror.style.top = "0";
    mirror.style.left = "-9999px";
    mirror.textContent = ta.value.substring(0, ta.selectionStart);
    const marker = document.createElement("span");
    marker.textContent = "\u200B";
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const mr = marker.getBoundingClientRect();
    const mir = mirror.getBoundingClientRect();
    const out = {
      left: rect.left + (mr.left - mir.left),
      top: rect.top + (mr.top - mir.top) - ta.scrollTop,
      lineHeight,
    };
    document.body.removeChild(mirror);
    return out;
  }
  _position() {
    if (!this.el) return;
    const c = this._caretCoords();
    const menuW = Math.min(360, window.innerWidth - 16);
    let left = Math.max(8, Math.min(c.left, window.innerWidth - menuW - 8));
    let top = c.top + c.lineHeight + 6;
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
    this.el.style.width = `${menuW}px`;
    requestAnimationFrame(() => {
      const r = this.el.getBoundingClientRect();
      if (r.bottom > window.innerHeight - 8) {
        const above = c.top - r.height - 6;
        if (above > 8) this.el.style.top = `${above}px`;
      }
    });
  }
  _insert(item) {
    const activeTab = this.tabs.find((t) => t.id === this.activeTabId);
    if (!activeTab || item.disabled) return;
    if (activeTab.id === "ref") {
      const budget = this.cfg.getRefBudget?.({
        text: this.textarea.value,
        cursor: this.textarea.selectionStart,
        atPos: this.atPos,
        items: this.items,
      });
      if (budget && !budget.canAdd(item)) {
        this._render();
        return;
      }
    }
    let text = "";
    try {
      text = activeTab.buildInsert(item);
    } catch (_) {
      return;
    }
    const ta = this.textarea;
    const cursor = ta.selectionStart;
    ta.value = ta.value.slice(0, this.atPos) + text + ta.value.slice(cursor);
    ta.selectionStart = ta.selectionEnd = this.atPos + text.length;
    this.hide();
    ta.focus();
    try {
      this.cfg.onInsert?.(item, activeTab);
    } catch (_) {}
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
  static wrapName(name, prefix) {
    const clean = /^[A-Za-z0-9_]+$/.test(name);
    return clean ? `@${prefix}${name} ` : `@${prefix}[${name}] `;
  }
  static flowRefBudget({
    text = "",
    cursor = 0,
    atPos = -1,
    items = [],
    caps = {},
    characterSelection = "",
    multiPrompt = false,
    isFrames = false,
  } = {}) {
    const source = String(text || "");
    let start = 0;
    let end = source.length;
    if (multiPrompt) {
      const separators = /\n\s*\n/g;
      let match;
      while ((match = separators.exec(source)) && match.index < cursor)
        start = separators.lastIndex;
      separators.lastIndex = start;
      match = separators.exec(source);
      if (match) end = match.index;
    }
    let prompt = source.slice(start, end);
    if (atPos >= start && atPos < cursor && cursor <= end) {
      prompt = source.slice(start, atPos) + source.slice(cursor, end);
    }
    const byName = new Map(
      items.map((item) => [String(item.value || item.label || ""), item]),
    );
    const selected = new Map();
    for (const mention of window.MentionParser?.parseMentions?.(prompt) || []) {
      const rawName = String(mention.imageName || "");
      const item =
        byName.get(rawName) || byName.get(rawName.replace(/^\[|\]$/g, ""));
      if (item)
        selected.set(
          String(item.fileId || item.value),
          item.mediaType === "video" ? "video" : "image",
        );
    }
    const images = [...selected.values()].filter(
      (type) => type === "image",
    ).length;
    const videos = selected.size - images;
    const characterNames = isFrames
      ? []
      : (window.MentionParser?.parseComponents?.(prompt) || [])
          .filter((part) => part.type === "char")
          .map((part) =>
            String(part.name || "")
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean);
    const characters = characterNames.length
      ? new Set(characterNames).size
      : isFrames
        ? 0
        : window.CharacterRegistry?.payload?.(characterSelection)?.selections
            ?.length || 0;
    const cap = Number.isInteger(caps.total) ? Math.max(0, caps.total) : null;
    const max = isFrames ? Math.min(cap ?? 2, 2) : cap;
    const imageMax = Number.isInteger(caps.image)
      ? Math.max(0, caps.image)
      : null;
    const videoMax = Number.isInteger(caps.video) ? Math.max(0, caps.video) : 0;
    return {
      used: images + videos + characters,
      max,
      images,
      videos,
      characters,
      isSelected(item) {
        return selected.has(String(item.fileId || item.value));
      },
      canAdd(item) {
        const id = String(item.fileId || item.value);
        if (selected.has(id)) return false;
        const video = item.mediaType === "video";
        if (
          video ? videos >= videoMax : imageMax !== null && images >= imageMax
        )
          return false;
        return max === null || images + videos + characters < max;
      },
    };
  }
  static voiceTab() {
    return {
      id: "voice",
      label: window.I18n?.t?.("mention.tabVoice") || "Voice",
      iconSvg: _MentionMenu.ICONS.voice,
      getItems: () =>
        (window.VoiceRegistry?.getRenderListSync?.("flow") || []).map((v) => ({
          label: v.display_name || v.name || v.search_value,
          sublabel: v.description || (v.is_custom ? "Custom" : ""),
          iconSvg: _MentionMenu.ICONS.voice,
          value: v.search_value || v.name,
        })),
      buildInsert: (item) => _MentionMenu.wrapName(item.value, "voice:"),
    };
  }
  static charTab() {
    return {
      id: "char",
      label: window.I18n?.t?.("mention.tabChar") || "Character",
      iconSvg: _MentionMenu.ICONS.char,
      getItems: () =>
        (window.CharacterRegistry?.getRenderListSync?.() || []).map((c) => ({
          label: c.name || c.search_value,
          thumbnail: c.thumbnail_url || null,
          iconSvg: _MentionMenu.ICONS.char,
          value: c.search_value || c.name,
        })),
      buildInsert: (item) => _MentionMenu.wrapName(item.value, "char:"),
    };
  }
};
__publicField(_MentionMenu, "ICONS", {
  voice:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>',
  char: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>',
  node: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>',
  ref: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>',
});
let MentionMenu = _MentionMenu;
window.MentionMenu = MentionMenu;
