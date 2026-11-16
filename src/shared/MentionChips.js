class MentionChips {
  constructor(textarea, cfg) {
    this.textarea = textarea;
    this.cfg = cfg || {};
    this.row = document.createElement("div");
    this.row.className = "mention-chips-row";
    this._failedThumbnails = new Set();
    this._renderedHtml = null;
    const host = this.cfg.container || textarea.parentElement;
    if (host) {
      const toolbar = host.querySelector(".prompt-editor-toolbar");
      if (toolbar) host.insertBefore(this.row, toolbar);
      else host.appendChild(this.row);
    }
    this._debounce = null;
    this._boundInput = () => {
      if (this._debounce) clearTimeout(this._debounce);
      this._debounce = setTimeout(() => this.render(), 150);
    };
    textarea.addEventListener("input", this._boundInput);
    this.row.addEventListener("click", (e) => {
      const btn = e.target.closest(".mention-chip-x");
      if (!btn) return;
      const chip = btn.closest(".mention-chip-v2");
      if (!chip) return;
      this._removeMention(parseInt(chip.dataset.index, 10), chip.dataset.full);
    });
    this.row.addEventListener(
      "error",
      (e) => {
        const img = e.target;
        if (!img?.classList?.contains("mention-chip-v2-thumb")) return;
        this._failedThumbnails.add(img.getAttribute("src"));
        const chip = img.closest(".mention-chip-v2");
        const fallback = document.createElement("span");
        fallback.className = "mention-chip-v2-icon";
        fallback.innerHTML =
          window.MentionMenu?.ICONS?.[chip?.dataset.kind] || "";
        img.replaceWith(fallback);
        this._renderedHtml = null;
      },
      true,
    );
    this.row.addEventListener(
      "wheel",
      (e) => {
        if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
        const maxScroll = this.row.scrollWidth - this.row.clientWidth;
        if (maxScroll <= 0) return;
        const unit =
          e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.row.clientWidth : 1;
        const next = Math.max(
          0,
          Math.min(maxScroll, this.row.scrollLeft + e.deltaY * unit),
        );
        if (next === this.row.scrollLeft) return;
        e.preventDefault();
        this.row.scrollLeft = next;
      },
      { passive: false },
    );
    this.render();
  }
  destroy() {
    this.textarea.removeEventListener("input", this._boundInput);
    this.row.remove();
  }
  _esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  _collect() {
    const text = this.textarea.value || "";
    const MP = window.MentionParser;
    if (!MP) return [];
    const out = [];
    if (this.cfg.includeComponents?.() !== false) {
      for (const c of MP.parseComponents(text)) {
        out.push({
          kind: c.type,
          name: c.name,
          index: c.index,
          fullMatch: c.fullMatch,
        });
      }
    }
    if (this.cfg.includeRefs?.()) {
      for (const m of MP.parseMentions(text)) {
        let name = m.imageName;
        if (name.startsWith("[") && name.endsWith("]"))
          name = name.slice(1, -1);
        out.push({ kind: "ref", name, index: m.index, fullMatch: m.fullMatch });
      }
    }
    return out.sort((a, b) => a.index - b.index);
  }
  _resolve(m) {
    if (m.kind === "voice") {
      const list = window.VoiceRegistry?.getRenderListSync?.("flow") || [];
      return {
        found: list.some((v) => (v.search_value || v.name) === m.name),
        uncertain: list.length === 0,
        thumbnail: null,
        iconSvg: window.MentionMenu?.ICONS?.voice || "",
      };
    }
    if (m.kind === "char") {
      const reg = window.CharacterRegistry;
      const hit = reg?.findByName?.(m.name);
      return {
        found: !!hit,
        uncertain: !reg?.findByName,
        thumbnail: hit?.thumbnail_url || null,
        iconSvg: window.MentionMenu?.ICONS?.char || "",
      };
    }
    const r = this.cfg.resolveRef?.(m.name);
    return {
      found: !!r?.found,
      uncertain: !this.cfg.resolveRef || !r,
      thumbnail: r?.thumbnail || null,
      iconSvg: window.MentionMenu?.ICONS?.ref || "",
    };
  }
  render() {
    const mentions = this._collect()
      .map((m) => ({ m, r: this._resolve(m) }))
      .filter(({ r }) => r.found || r.uncertain);
    const budgets = this.cfg.getRefBudgets?.() || [];
    const overLimit = budgets.filter(
      (budget) => Number.isInteger(budget.max) && budget.used > budget.max,
    );
    if (mentions.length === 0 && overLimit.length === 0) {
      if (this._renderedHtml !== "") this.row.innerHTML = "";
      this._renderedHtml = "";
      this.row.style.display = "none";
      return;
    }
    this.row.style.display = "";
    const notFoundTip =
      window.I18n?.t?.("mention.notFoundChip") ||
      "Not found \u2014 will be skipped when running";
    const budgetHtml = overLimit
      .map(
        (budget) => `<span class="mention-chip-budget-over"
      title="${budget.used}/${budget.max}">${budgets.length > 1 ? `P${budget.promptIndex + 1} ` : ""}${budget.used}/${budget.max}</span>`,
      )
      .join("");
    const html =
      budgetHtml +
      mentions
        .map(({ m, r }) => {
          const { found, thumbnail, iconSvg } = r;
          const thumbHtml =
            thumbnail && !this._failedThumbnails.has(thumbnail)
              ? `<img class="mention-chip-v2-thumb" src="${this._esc(thumbnail)}" alt="">`
              : `<span class="mention-chip-v2-icon">${iconSvg}</span>`;
          return `
        <span class="mention-chip-v2 mention-chip-v2--${m.kind}${found ? "" : " mention-chip-v2--warn"}"
              data-index="${m.index}" data-kind="${m.kind}" data-full="${this._esc(m.fullMatch)}"
              ${found ? "" : `title="${this._esc(notFoundTip)}"`}>
          ${thumbHtml}
          <span class="mention-chip-v2-name">${this._esc(m.name)}</span>
          <button type="button" class="mention-chip-x" title="Remove">
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </span>`;
        })
        .join("");
    if (this._renderedHtml !== html) {
      this.row.innerHTML = html;
      this._renderedHtml = html;
    }
  }
  _removeMention(index, fullMatch) {
    const ta = this.textarea;
    const text = ta.value;
    if (text.slice(index, index + fullMatch.length) !== fullMatch) {
      this.render();
      return;
    }
    let before = text.slice(0, index);
    let after = text.slice(index + fullMatch.length);
    if (before.endsWith(" ") && after.startsWith(" ")) after = after.slice(1);
    ta.value = (before + after).replace(/[ \t]{2,}/g, " ");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
}
window.MentionChips = MentionChips;
