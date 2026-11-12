// Char Differ: Marinara API and helper client.
//
// Marinara routes (packages/server/src/routes/characters.routes.ts):
//   GET   /api/characters/:id           row; `data` is a JSON string, `updatedAt` for conflict checks
//   GET   /api/characters/:id/versions  [current, ...saved newest first]; `data` already parsed
//   PATCH /api/characters/:id           { data, versionSource, versionReason }. Marinara snapshots the
//                                       card it replaces, so the pre-merge card stays in Version History.
//                                       `extensions` and `character_book` are deep-merged; arrays replace.
//
// Helper (helper/chardiffer-helper.mjs), Authorization: Bearer <token>:
//   GET /health, POST /sessions, GET /sessions/:id?wait=25, DELETE /sessions/:id

const CDApi = (() => {
  "use strict";

  const WRITE_HEADERS = { "Content-Type": "application/json", "x-marinara-csrf": "1" };
  const DEFAULT_SETTINGS = Object.freeze({ helperUrl: "http://127.0.0.1:7869", token: "" });

  async function request(path, init) {
    const response = await marinara.fetch(path, init);
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const message = body && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
      const error = new Error(`${init?.method ?? "GET"} ${path.split("?")[0]} failed: ${message}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  const parseData = (data) => (typeof data === "string" ? JSON.parse(data) : data);

  async function getCharacter(id) {
    const row = await request(`/api/characters/${encodeURIComponent(id)}`);
    return { ...row, data: parseData(row.data) };
  }

  async function listVersions(id) {
    const rows = await request(`/api/characters/${encodeURIComponent(id)}/versions`);
    return Array.isArray(rows) ? rows.map((row) => ({ ...row, data: parseData(row.data) })) : [];
  }

  async function saveCharacter(id, data, reason) {
    const row = await request(`/api/characters/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ data, versionSource: "char-differ", versionReason: reason }),
    });
    return { ...row, data: parseData(row.data) };
  }

  // ── Settings ──

  async function settings() {
    try {
      const stored = (await marinara.storage.get()) ?? {};
      return { ...DEFAULT_SETTINGS, ...stored };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }
  const saveSettings = (patch) => marinara.storage.patch(patch);

  // ── Helper ──

  class HelperError extends Error {}

  async function helper(path, init = {}) {
    const { helperUrl, token } = await settings();
    if (!token) throw new HelperError("No helper token set. Open Char Differ's settings (gear button) and paste it.");
    let response;
    try {
      response = await marinara.fetch(`${helperUrl.replace(/\/+$/, "")}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
        credentials: "omit",
      });
    } catch {
      throw new HelperError(`The Char Differ helper isn't answering at ${helperUrl}. Start it with: node helper/chardiffer-helper.mjs`);
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) throw new HelperError(body?.error ?? `Helper answered HTTP ${response.status}`);
    return body;
  }

  const health = () => helper("/health");
  const openSession = (payload) => helper("/sessions", { method: "POST", body: JSON.stringify(payload) });
  const pollSession = (id, wait = 25) => helper(`/sessions/${id}?wait=${wait}`);
  const closeSession = (id) => helper(`/sessions/${id}`, { method: "DELETE" }).catch(() => null);

  return Object.freeze({
    getCharacter,
    listVersions,
    saveCharacter,
    settings,
    saveSettings,
    DEFAULT_SETTINGS,
    HelperError,
    health,
    openSession,
    pollSession,
    closeSession,
  });
})();
