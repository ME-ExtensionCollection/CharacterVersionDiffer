// Mock Marinara host for the dev harness: window.__marinaraRunFullPageExtension
// with a fake `marinara` API, a UI store and query client on __MARINARA_HOST__,
// and a copy of the character editor's Version History panel markup
// (CharacterVersionHistoryPanel in packages/client/src/components/characters/CharacterEditor.tsx).
(() => {
  "use strict";

  const STORE_KEY = "chardiffer-harness-storage";
  const cleanups = [];
  const readStore = () => {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
    } catch {
      return {};
    }
  };
  const storage = Object.freeze({
    async get() {
      return readStore();
    },
    async patch(value) {
      const next = { ...readStore(), ...value };
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
      return next;
    },
    async delete() {
      localStorage.removeItem(STORE_KEY);
    },
  });

  // ── The panel, re-rendered from GET /versions like React would ──

  const svg = (name) =>
    `<svg class="lucide lucide-${name}" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  const panelRoot = document.getElementById("mock-panel");
  panelRoot.innerHTML = `
    <div class="rounded-xl border p-2.5">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="inline-flex items-center gap-1.5">${svg("history")} Version History</span>
        <div class="flex items-center gap-1.5">
          <button type="button" class="mari-editor-action mari-editor-action--compact">${svg("rotate-ccw")} Reset</button>
          <span class="chip" id="mock-count">…</span>
        </div>
      </div>
      <div class="mt-2 flex flex-col gap-1.5 overflow-y-auto" id="mock-rows"></div>
    </div>`;
  const rowsNode = document.getElementById("mock-rows");

  async function render() {
    const versions = await (await fetch("/api/characters/alice/versions")).json();
    document.getElementById("mock-count").textContent = `${versions.length - 1} saved`;
    rowsNode.innerHTML = versions
      .map(
        (v) => `<div class="row flex items-center gap-2" data-version="${esc(v.id)}">
          <button type="button" class="min-w-0 flex-1 text-left" ${v.isCurrent ? "disabled" : ""}>
            <span class="title">${v.isCurrent ? "Current card" : `v${esc(v.version)}`}</span>
            <span class="sub">${esc(v.createdAt)}${v.isCurrent ? "" : ` · ${esc(v.source)}`}</span>
          </button>
          ${v.isCurrent ? "" : `<button type="button" class="mari-editor-action" title="Rename">${svg("pencil")}</button><button type="button" class="mari-editor-action" title="Restore">${svg("rotate-ccw")}</button>`}
        </div>`,
      )
      .join("");
    window.__cdHarness.renders += 1;
  }

  const uiState = {
    characterDetailId: "alice",
    personaDetailId: null,
    get editorDirty() {
      return document.getElementById("mock-dirty").checked;
    },
    openCharacterDetail() {},
  };
  const ui = { getState: () => uiState, subscribe: () => () => {} };
  const queryClient = {
    invalidations: [],
    getQueryCache: () => ({}),
    invalidateQueries(filter) {
      this.invalidations.push(filter.queryKey);
      if (filter.queryKey[1] === "detail") void render();
      return Promise.resolve();
    },
  };
  globalThis.__MARINARA_HOST__ = { stores: { ui }, queryClient };

  window.__cdHarness = {
    renders: 0,
    render,
    queryClient,
    resetStorage: () => localStorage.removeItem(STORE_KEY),
    async stop() {
      for (const fn of cleanups.reverse()) await fn();
      cleanups.length = 0;
    },
  };
  void render();

  window.__marinaraRunFullPageExtension = (identity, main) => {
    const api = Object.freeze({
      version: 1,
      extension: Object.freeze(identity),
      log: Object.freeze({ debug: console.debug, info: console.info, warn: console.warn, error: console.error }),
      storage,
      fetch: (input, init) => window.fetch(input, init),
      setTimeout: (cb, ms, ...args) => window.setTimeout(cb, ms, ...args),
      clearTimeout: (id) => window.clearTimeout(id),
      setInterval: (cb, ms, ...args) => window.setInterval(cb, ms, ...args),
      clearInterval: (id) => window.clearInterval(id),
      onCleanup: (fn) => cleanups.push(fn),
    });
    Promise.resolve(main(api)).catch((error) => console.error("[mock marinara] extension failed", error));
  };
})();
