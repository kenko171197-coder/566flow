(() => {
  "use strict";
  const fields = ["voiceDescription", "motionCustomPrompt"];
  let eventBus = null;
  let unsubscribe = [];
  const translate = (key, values) => {
    const text = window.I18n?.t(key, values);
    return text && text !== key ? text : "";
  };
  function refresh() {
    if (window.eventBus?.on && window.eventBus !== eventBus) {
      unsubscribe.forEach((off) => {
        if (typeof off === "function") off();
      });
      eventBus = window.eventBus;
      unsubscribe = ["i18n:changed", "i18n:reloaded"].map((event) =>
        eventBus.on(event, refresh),
      );
    }
    let valid = true;
    for (const id of fields) {
      const input = document.getElementById(id);
      if (!input) continue;
      const limit = Number(input.dataset.characterLimit);
      if (!Number.isSafeInteger(limit) || limit <= 0) continue;
      const count = Array.from(input.value).length;
      const over = Math.max(0, count - limit);
      const active =
        id !== "voiceDescription" ||
        document.getElementById("voiceEnabled")?.checked;
      const invalid = !!active && over > 0;
      const counter = document.getElementById(`${id}Counter`);
      const error = document.getElementById(`${id}LimitError`);
      const message = invalid
        ? translate("motionEditor.textLimitExceeded", { over, limit }) ||
          `+${over}`
        : "";
      if (counter) counter.textContent = `${count} / ${limit}`;
      if (error) {
        error.textContent = message;
        error.hidden = !invalid;
      }
      input.setAttribute("aria-invalid", String(invalid));
      input.setCustomValidity(message);
      input
        .closest(".setting-field")
        ?.classList.toggle("motion-text-over-limit", invalid);
      valid && (valid = !invalid);
    }
    return valid;
  }
  function init() {
    for (const id of fields) {
      const input = document.getElementById(id);
      if (!input || input.dataset.characterLimit) continue;
      if (input.maxLength <= 0) continue;
      input.dataset.characterLimit = String(input.maxLength);
      input.removeAttribute("maxlength");
      for (const event of ["input", "change", "compositionend"])
        input.addEventListener(event, refresh);
    }
    document
      .getElementById("voiceEnabled")
      ?.addEventListener("change", refresh);
    refresh();
  }
  window.MotionTextFieldLimits = { init, refresh };
  init();
})();
