(() => {
  class MotionSplitSettingsDialog {
    static text(key, values = {}) {
      const full = `motionSplit.${key}`;
      const value = window.I18n?.t?.(full, values);
      if (!value || value === full)
        throw new Error("MOTION_SPLIT_TRANSLATIONS_REQUIRED");
      return value;
    }
    static open({ frameCount, resultCount, canResplit }) {
      const t = (key, values) => this.text(key, values);
      const labels = Object.fromEntries(
        [
          "title",
          "description",
          "keep",
          "keepHint",
          "resplit",
          "resplitHint",
          "cancel",
          "applyKeep",
          "applyResplit",
          "missingSource",
          "existingResults",
        ].map((key) => [
          key,
          t(key, { count: frameCount, results: resultCount }),
        ]),
      );
      return new Promise((resolve) => {
        const dialog = document.createElement("dialog");
        dialog.className = "motion-split-decision";
        const title = document.createElement("h2");
        title.id = "motionSplitDecisionTitle";
        title.textContent = labels.title;
        dialog.setAttribute("aria-labelledby", title.id);
        const description = document.createElement("p");
        description.textContent = labels.description;
        dialog.append(title, description);
        const fieldset = document.createElement("fieldset");
        const legend = document.createElement("legend");
        legend.className = "sr-only";
        legend.textContent = labels.title;
        fieldset.append(legend);
        for (const value of ["keep", "resplit"]) {
          const label = document.createElement("label");
          const radio = document.createElement("input");
          radio.type = "radio";
          radio.name = "motionSplitDecision";
          radio.value = value;
          radio.checked = value === "keep";
          radio.disabled = value === "resplit" && !canResplit;
          const body = document.createElement("span");
          const strong = document.createElement("strong");
          strong.textContent = labels[value];
          const hint = document.createElement("small");
          hint.textContent = labels[`${value}Hint`];
          body.append(strong, hint);
          label.append(radio, body);
          fieldset.append(label);
        }
        dialog.append(fieldset);
        const warning = document.createElement("p");
        warning.className = "motion-split-decision-warning";
        warning.hidden = true;
        warning.textContent = labels.existingResults;
        dialog.append(warning);
        if (!canResplit) {
          const note = document.createElement("p");
          note.textContent = labels.missingSource;
          dialog.append(note);
        }
        const footer = document.createElement("footer");
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "btn btn-secondary";
        cancel.textContent = labels.cancel;
        const apply = document.createElement("button");
        apply.type = "button";
        apply.className = "btn btn-primary";
        apply.textContent = labels.applyKeep;
        footer.append(cancel, apply);
        dialog.append(footer);
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          dialog.close();
          dialog.remove();
          resolve(value);
        };
        fieldset.addEventListener("change", () => {
          const resplit =
            dialog.querySelector("input:checked").value === "resplit";
          apply.textContent = resplit ? labels.applyResplit : labels.applyKeep;
          warning.hidden = !resplit || resultCount === 0;
        });
        cancel.addEventListener("click", () => finish(null));
        apply.addEventListener("click", () =>
          finish(dialog.querySelector("input:checked").value),
        );
        dialog.addEventListener("cancel", (event) => {
          event.preventDefault();
          finish(null);
        });
        dialog.addEventListener("close", () => {
          if (!settled) finish(null);
        });
        document.body.append(dialog);
        try {
          dialog.showModal();
        } catch (error) {
          dialog.remove();
          throw error;
        }
        dialog.querySelector("input:checked").focus();
      });
    }
  }
  window.MotionSplitSettingsDialog = MotionSplitSettingsDialog;
})();
