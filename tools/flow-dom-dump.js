// Paste into DevTools console on https://flow.google.com. It copies a compact JSON summary of
// interactive elements to your clipboard (nothing is sent anywhere). Then paste it into the chat.
(() => {
  const short = (s, n = 40) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const buttons = [...document.querySelectorAll('button, [role="button"], [role="tab"], [role="menuitem"], [role="option"], a[href]')]
    .filter(visible).slice(0, 150).map((el) => ({
      tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), aria: el.getAttribute("aria-label"),
      text: short(el.textContent), icon: short(el.querySelector("i, .material-icons, .google-symbols, mat-icon")?.textContent, 24),
      testid: el.getAttribute("data-testid"), haspopup: el.getAttribute("aria-haspopup"),
      id: /^(radix|:r)/.test(el.id) ? "(dyn)" : short(el.id, 30),
    }));
  const dataAttrs = {};
  document.querySelectorAll("*").forEach((el) => {
    for (const a of el.attributes) if (a.name.startsWith("data-") && !a.name.startsWith("data-v-"))
      dataAttrs[a.name] = (dataAttrs[a.name] || 0) + 1;
  });
  const editor = document.querySelector('[contenteditable="true"]');
  const media = [...document.querySelectorAll("img, video")].filter(visible).slice(0, 12).map((el) => {
    const chain = []; let p = el.parentElement;
    for (let i = 0; i < 5 && p; i++, p = p.parentElement)
      chain.push(p.tagName.toLowerCase() + [...p.attributes].filter(a => a.name.startsWith("data-") || a.name === "role").map(a => `[${a.name}]`).join(""));
    return { tag: el.tagName.toLowerCase(), chain };
  });
  const out = { url: location.pathname.replace(/[0-9a-f-]{20,}/g, ":id"), buttons, dataAttrs, media,
    editor: editor ? editor.outerHTML.slice(0, 300) : null, alerts: [...document.querySelectorAll('[role="alert"],[role="dialog"]')].map(e => short(e.textContent, 80)) };
  copy(JSON.stringify(out));
  console.log("Copied " + JSON.stringify(out).length + " chars. Paste it into the chat.");
})();
