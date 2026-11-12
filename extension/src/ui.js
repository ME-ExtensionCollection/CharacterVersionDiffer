// Char Differ: buttons in the character editor's Version History panel, the
// meld round trip, and the dialogs around it.
//
// Panel: CharacterVersionHistoryPanel in
// packages/client/src/components/characters/CharacterEditor.tsx. It has no
// data attributes, so it is found by its header: a <History> icon next to a
// Reset button with a <RotateCcw> icon. Rows follow GET /versions order
// (current card first, then saved versions newest first).

const CDUi = (() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICONS = {
    // lucide git-compare
    compare: [
      ["circle", { cx: 18, cy: 18, r: 3 }],
      ["circle", { cx: 6, cy: 6, r: 3 }],
      ["path", { d: "M13 6h3a2 2 0 0 1 2 2v7" }],
      ["path", { d: "M11 18H8a2 2 0 0 1-2-2V9" }],
    ],
    // lucide settings
    settings: [
      [
        "path",
        {
          d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
        },
      ],
      ["circle", { cx: 12, cy: 12, r: 3 }],
    ],
  };

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, "svg");
    for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: "0.75rem", height: "0.75rem", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
    for (const [tag, attrs] of ICONS[name]) {
      const node = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      svg.append(node);
    }
    return svg;
  }

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (key in node && typeof value !== "string") node[key] = value;
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
    return node;
  }

  // ── Toasts ──

  let toastRoot = null;
  function toast(message, { error = false, duration = 6000, actions = [], sticky = false } = {}) {
    if (!toastRoot?.isConnected) {
      toastRoot = el("div", { class: "cd-toasts", "aria-live": "polite" });
      document.body.append(toastRoot);
    }
    const node = el("div", { class: `cd-toast${error ? " cd-toast--error" : ""}`, role: error ? "alert" : "status" });
    const text = el("div", { class: "cd-toast__text", text: message });
    const buttons = el("div", { class: "cd-toast__actions" });
    let timer = 0;
    const handle = {
      close() {
        if (timer) marinara.clearTimeout(timer);
        node.remove();
      },
      update(next) {
        text.textContent = next;
      },
    };
    for (const action of actions) {
      buttons.append(el("button", { type: "button", class: "cd-btn cd-btn--small", text: action.label, onclick: () => (handle.close(), action.run()) }));
    }
    buttons.append(el("button", { type: "button", class: "cd-btn cd-btn--small cd-btn--ghost", "aria-label": "Dismiss", text: "×", onclick: () => handle.close() }));
    node.append(text, buttons);
    toastRoot.append(node);
    if (!sticky) timer = marinara.setTimeout(() => handle.close(), duration);
    return handle;
  }

  // ── Dialog ──

  /** Resolves with the chosen button id, or null on Esc / backdrop. */
  function dialog({ title, body = [], buttons = [{ id: "ok", label: "OK", primary: true }], wide = false }) {
    return new Promise((resolve) => {
      const previous = document.activeElement;
      const done = (value) => {
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
        previous?.focus?.();
        resolve(value);
      };
      const onKey = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          done(null);
        }
      };
      const footer = el(
        "div",
        { class: "cd-dialog__buttons" },
        buttons.map((b) =>
          el("button", {
            type: "button",
            class: `cd-btn${b.primary ? " cd-btn--primary" : ""}${b.danger ? " cd-btn--danger" : ""}`,
            text: b.label,
            onclick: () => done(b.onClick ? b.onClick() ?? b.id : b.id),
          }),
        ),
      );
      const box = el("div", { class: `cd-dialog${wide ? " cd-dialog--wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-label": title },
        el("h2", { class: "cd-dialog__title", text: title }),
        el("div", { class: "cd-dialog__body" }, body),
        footer,
      );
      const overlay = el("div", { class: "cd-overlay", onmousedown: (event) => event.target === overlay && done(null) }, box);
      document.addEventListener("keydown", onKey, true);
      document.body.append(overlay);
      (footer.querySelector(".cd-btn--primary") ?? footer.querySelector("button"))?.focus();
    });
  }

  const p = (text, cls = "") => el("p", { class: cls, text });

  // ── Settings ──

  async function openSettings() {
    const current = await CDApi.settings();
    const url = el("input", { class: "cd-input", type: "url", value: current.helperUrl, spellcheck: false });
    const token = el("input", { class: "cd-input", type: "password", value: current.token, spellcheck: false, autocomplete: "off", placeholder: "from ~/.config/chardiffer/token" });
    const status = p("", "cd-muted");
    const test = async () => {
      await CDApi.saveSettings({ helperUrl: url.value.trim() || CDApi.DEFAULT_SETTINGS.helperUrl, token: token.value.trim() });
      status.textContent = "Checking…";
      try {
        const health = await CDApi.health();
        status.textContent = `Connected: helper ${health.version}, using ${health.tool}.`;
      } catch (error) {
        status.textContent = error.message;
      }
      return "test";
    };
    for (;;) {
      const choice = await dialog({
        title: "Char Differ settings",
        body: [
          p("Start the helper on this computer, then paste the token it prints:"),
          el("pre", { class: "cd-code", text: "node helper/chardiffer-helper.mjs" }),
          el("label", { class: "cd-field" }, el("span", { text: "Helper address" }), url),
          el("label", { class: "cd-field" }, el("span", { text: "Token" }), token),
          status,
        ],
        buttons: [
          { id: "test", label: "Save and test" },
          { id: "save", label: "Save", primary: true },
          { id: "cancel", label: "Cancel" },
        ],
      });
      if (choice === "test") {
        // The dialog closed; reopen it with the result shown.
        await test();
        continue;
      }
      if (choice === "save") {
        await CDApi.saveSettings({ helperUrl: url.value.trim() || CDApi.DEFAULT_SETTINGS.helperUrl, token: token.value.trim() });
        toast("Char Differ settings saved.");
      }
      return;
    }
  }

  // ── The meld round trip ──

  let active = null; // { cancelled, sessionId, toast }

  /**
   * One comparison: `left` is read-only reference, the right side starts as
   * `rightData` and is the card being edited; `base` is the card on the
   * server the result will be saved over.
   */
  async function roundTrip(job) {
    const { characterId, name, left, base } = job;
    const rightData = job.rightData ?? base.data;
    let leftText;
    let rightText;
    try {
      leftText = job.leftText ?? CDCore.serialize(left.data, { others: [base.data, rightData], title: `${name} — ${left.label}` });
      rightText = job.rightText ?? CDCore.serialize(rightData, { others: [base.data, left.data], title: `${name} — current card (edit, save, close)` });
    } catch (error) {
      toast(error.message, { error: true, duration: 12000 });
      return;
    }

    const session = await CDApi.openSession({
      title: name,
      left: { label: `${name} — ${left.label} (read-only)`, text: leftText },
      right: { label: `${name} — current card (edit, save, close)`, text: rightText },
    });
    const run = { cancelled: false, sessionId: session.id, toast: null };
    active = run;
    run.toast = toast(`Meld is open for ${name}. Edit the right side, save, and close meld to continue.`, {
      sticky: true,
      actions: [{ label: "Cancel", run: () => ((run.cancelled = true), void CDApi.closeSession(run.sessionId)) }],
    });

    let result = null;
    let failures = 0;
    try {
      while (!run.cancelled) {
        try {
          const answer = await CDApi.pollSession(session.id, 25);
          failures = 0;
          if (answer.status === "closed") {
            result = answer;
            break;
          }
        } catch (error) {
          failures += 1;
          if (failures >= 4) throw error;
          await new Promise((resolve) => marinara.setTimeout(resolve, 1000 * failures));
        }
      }
    } finally {
      run.toast.close();
      if (active === run) active = null;
    }
    if (run.cancelled) return toast("Comparison cancelled. Nothing was saved.");
    if (result.error) return toast(`The diff tool failed: ${result.error}`, { error: true, duration: 12000 });
    // A reopened comparison already carries earlier edits, so "unchanged" still has something to save.
    const continued = job.rightData !== undefined || job.rightText !== undefined;
    if (!result.changed && !continued) return toast(`No changes saved in meld for ${name}.`);

    const others = [base.data, left.data];
    let merged;
    try {
      merged = CDCore.parse(result.text, rightData, { others });
    } catch (error) {
      const choice = await dialog({
        title: "Couldn't read the edited card",
        body: [p(error.message), p("Nothing was saved. Reopen meld with your edits to fix it?", "cd-muted")],
        buttons: [
          { id: "reopen", label: "Reopen meld", primary: true },
          { id: "discard", label: "Discard my edits", danger: true },
        ],
      });
      if (choice === "reopen") return roundTrip({ ...job, rightText: result.text, leftText });
      return toast("Edits discarded. Nothing was saved.");
    }

    // Did the card change on the server while meld was open?
    const fresh = await CDApi.getCharacter(characterId);
    if (fresh.updatedAt !== base.updatedAt && !CDCore.same(fresh.data, base.data)) {
      const choice = await dialog({
        title: `${name} changed while meld was open`,
        body: [
          p("Something else saved this card in the meantime (the editor, a model, another extension)."),
          p("Compare your merged text with the card as it is now? The left side will show the new card.", "cd-muted"),
        ],
        buttons: [
          { id: "reopen", label: "Compare with the new card", primary: true },
          { id: "discard", label: "Discard my edits", danger: true },
        ],
      });
      if (choice !== "reopen") return toast("Edits discarded. Nothing was saved.");
      return roundTrip({
        characterId,
        name,
        left: { data: fresh.data, label: "card now (changed while meld was open)" },
        base: { data: fresh.data, updatedAt: fresh.updatedAt },
        rightData: merged,
        reason: job.reason,
      });
    }

    const patch = CDCore.changes(base.data, merged);
    if (!Object.keys(patch).length) return toast(`Your result is the same as the current ${name} card. Nothing to save.`);
    const removed = CDCore.removedNestedKeys(base.data, patch);
    const state = CDBridge.editorState();
    const choice = await dialog({
      title: `Save changes to ${name}?`,
      body: [
        p("Fields that will change:"),
        el("ul", { class: "cd-list" }, CDCore.describeChanges(base.data, patch).map((text) => el("li", { text }))),
        removed.length
          ? p(`Marinara merges these fields instead of replacing them, so these deleted keys will stay on the card: ${removed.join(", ")}.`, "cd-warning")
          : null,
        state?.dirty ? p("The editor has unsaved edits. Marinara will merge them over the saved card.", "cd-warning") : null,
        p("The card as it is now is kept in Version History, so this can be undone there.", "cd-muted"),
      ],
      buttons: [
        { id: "save", label: "Save", primary: true },
        { id: "reopen", label: "Back to meld" },
        { id: "discard", label: "Discard", danger: true },
      ],
    });
    if (choice === "reopen") {
      return roundTrip({ ...job, rightData: merged, rightText: result.text, leftText });
    }
    if (choice !== "save") return toast("Edits discarded. Nothing was saved.");

    await CDApi.saveCharacter(characterId, patch, job.reason ?? `Merged in meld against ${left.label}`);
    const refreshed = CDBridge.refreshCharacter(characterId);
    toast(`Saved ${name}. The card from before the merge is in Version History.${refreshed ? "" : " Reopen the editor to see the changes."}`, { duration: 8000 });
  }

  /** Where a row sits in its panel's list right now, and how many rows there are. */
  function rowPosition(row) {
    for (const { rows } of findPanels()) {
      const index = rows.indexOf(row);
      if (index >= 0) return { index, count: rows.length };
    }
    return null;
  }

  /** `which`: "previous" or a version row element of the panel. */
  async function compare(which) {
    if (active) return toast("A comparison is already open in meld. Close it (or press Cancel) first.", { error: true });
    const state = CDBridge.editorState();
    if (!state?.characterId) {
      return toast("Char Differ couldn't tell which character is open. Reopen the editor and try again.", { error: true });
    }
    if (state.dirty) return toast("Save or discard your edits in the editor first.", { error: true });
    const { characterId } = state;
    try {
      const [current, versions] = await Promise.all([CDApi.getCharacter(characterId), CDApi.listVersions(characterId)]);
      const saved = versions.filter((version) => !version.isCurrent);
      let version = saved[0];
      if (which !== "previous") {
        const position = rowPosition(which);
        // Rows render GET /versions in order; if the counts differ the list is mid-refresh.
        version = position && position.count === versions.length ? versions[position.index] : null;
      }
      if (!version) return toast(which === "previous" ? "This card has no saved versions yet." : "The version list changed while loading. Try again.", { error: true });
      if (version.isCurrent) return toast("That's the current card.", { error: true });
      const name = current.data.name || "Character";
      const label = CDCore.versionLabel(version) || "previous version";
      await roundTrip({
        characterId,
        name,
        left: { data: version.data, label },
        base: { data: current.data, updatedAt: current.updatedAt },
        reason: `Merged in meld against ${label}`,
      });
    } catch (error) {
      marinara.log.warn("Char Differ comparison failed", error);
      const actions = error instanceof CDApi.HelperError ? [{ label: "Settings", run: () => void openSettings() }] : [];
      toast(error.message, { error: true, duration: 12000, actions });
    }
  }

  // ── Finding the Version History panel ──

  /** [{ panel, header, rows: Element[] }] for each character Version History panel on screen. */
  function findPanels() {
    const panels = [];
    for (const svg of document.querySelectorAll("svg.lucide-history")) {
      const header = svg.parentElement?.parentElement;
      const panel = header?.parentElement;
      if (!panel || svg.closest(".cd-overlay")) continue;
      // The header's right side holds Reset (RotateCcw) and the saved count chip.
      const controls = header.lastElementChild;
      if (!controls || controls === svg.parentElement || !controls.querySelector("button svg.lucide-rotate-ccw")) continue;
      const list = [...panel.children].find((child) => child !== header && child.classList.contains("overflow-y-auto"));
      panels.push({ panel, header, controls, rows: list ? [...list.children].filter((row) => row.querySelector(":scope > button")) : [] });
    }
    return panels;
  }

  function decorate() {
    const state = CDBridge.editorState();
    if (!state?.characterId || state.personaOpen) return;
    for (const { controls, rows } of findPanels()) {
      if (!controls.querySelector(".cd-header")) {
        const reset = controls.querySelector("button");
        const cls = reset?.className ?? "";
        const meld = el("button", {
          type: "button",
          class: `${cls} cd-meld`,
          title: "Open the current card and the most recent saved version in meld. Right-click: Char Differ settings",
          onclick: () => void compare("previous"),
          oncontextmenu: (event) => (event.preventDefault(), void openSettings()),
        }, icon("compare"), "Meld");
        const gear = el("button", { type: "button", class: `${cls} cd-gear`, title: "Char Differ settings", "aria-label": "Char Differ settings", onclick: () => void openSettings() }, icon("settings"));
        controls.prepend(el("span", { class: "cd-header" }, meld, gear));
      }
      rows.forEach((row) => {
        const first = row.querySelector(":scope > button");
        if (!first || first.disabled || row.querySelector(".cd-row-meld")) return; // disabled = current card
        const sample = row.querySelector(":scope > button + button");
        row.insertBefore(
          el("button", {
            type: "button",
            class: `${sample?.className ?? ""} cd-row-meld`,
            title: "Compare this version with the current card in meld",
            "aria-label": "Compare this version with the current card in meld",
            onclick: () => void compare(row),
          }, icon("compare")),
          sample ?? null,
        );
      });
    }
  }

  let frame = 0;
  const observer = new MutationObserver(() => {
    if (!frame) frame = requestAnimationFrame(() => ((frame = 0), decorate()));
  });
  observer.observe(document.body, { childList: true, subtree: true });
  decorate();

  marinara.onCleanup(() => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
    if (active) {
      active.cancelled = true;
      void CDApi.closeSession(active.sessionId);
      active.toast?.close();
    }
    for (const node of document.querySelectorAll(".cd-header, .cd-row-meld, .cd-toasts, .cd-overlay")) node.remove();
  });

  return Object.freeze({ compare, openSettings, toast, dialog, decorate });
})();
