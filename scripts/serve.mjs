// Dev harness server: builds the extension, then serves the repo on
// http://localhost:5180/dev/harness.html with a mock Marinara character API.
// Nothing here talks to a real Marinara install.
//
// Usage: node scripts/serve.mjs [port]
//   POST /__mock/reset   back to the seeded card (one saved version + an "AI-edited" current card)
//   POST /__mock/touch   change the current card, as if something else saved it
//   GET  /__mock/patches PATCH bodies received since the last reset
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json" };

export const ORIGINAL = Object.freeze({
  name: "Alice",
  description: "Alice is an elf who lives in a tree.\n\nShe loves riddles and hates loud noises.",
  personality: "curious, kind, a little shy",
  scenario: "{{user}} gets lost in Alice's forest.",
  first_mes: "*Alice peeks from behind a branch.* Who goes there?",
  mes_example: "<START>\n{{user}}: Hi!\n{{char}}: *hides* ...hi.",
  creator_notes: "Test card for Char Differ.",
  system_prompt: "",
  post_history_instructions: "",
  tags: ["Elf", "Fantasy", "Shy"],
  creator: "Kestrel",
  character_version: "1.0",
  alternate_greetings: ["*Alice is asleep in a hammock.*"],
  extensions: { talkativeness: "0.5", fav: false, versioningEnabled: true },
  character_book: null,
});

export const AI_EDITED = Object.freeze({
  ...ORIGINAL,
  description: "Alice is an elf who lives in a grand tree house.\n\nShe loves riddles, puzzles and hates loud noises. She is the strongest warrior in the realm.",
  personality: "curious, kind, a little shy, observant",
  character_version: "1.1",
  tags: ["Elf", "Fantasy", "Shy", "Warrior"],
});

const isRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v);
function mergeNested(current, patch) {
  const out = { ...current };
  for (const [k, v] of Object.entries(patch)) out[k] = isRecord(v) && isRecord(out[k]) ? mergeNested(out[k], v) : v;
  return out;
}

export function createMockApi() {
  let state;
  let clock;
  const stamp = () => new Date(Date.UTC(2026, 10, 11, 10, 0, clock++)).toISOString();
  function reset() {
    clock = 0;
    const firstSaved = stamp();
    state = {
      row: { id: "alice", data: { ...AI_EDITED }, comment: "", avatarPath: null, updatedAt: stamp() },
      versions: [{ id: "v1", characterId: "alice", data: { ...ORIGINAL }, version: "1.0", source: "manual", reason: "", createdAt: firstSaved, avatarPath: null, comment: "" }],
      patches: [],
    };
  }
  reset();

  function versions() {
    const saved = state.versions.map((v, i) => ({ ...v, revision: state.versions.length - i, isCurrent: false }));
    const current = state.row;
    return [
      { id: "current:alice", characterId: "alice", data: current.data, comment: "", avatarPath: null, version: current.data.character_version, source: "current", reason: "", createdAt: current.updatedAt, revision: saved.length + 1, isCurrent: true },
      ...saved,
    ];
  }

  function patch(body) {
    const before = state.row;
    state.versions.unshift({ id: `v${state.versions.length + 1}`, characterId: "alice", data: before.data, version: before.data.character_version, source: body.versionSource ?? "manual", reason: body.versionReason ?? "", createdAt: before.updatedAt, avatarPath: null, comment: "" });
    let data = { ...before.data, ...body.data };
    if (isRecord(body.data.extensions)) data.extensions = mergeNested(before.data.extensions, body.data.extensions);
    if (!("character_version" in body.data)) data.character_version = `${before.data.character_version}.1`;
    state.row = { ...before, data, updatedAt: stamp() };
    state.patches.push(body);
    return state.row;
  }

  const wire = (row) => ({ ...row, data: JSON.stringify(row.data) });

  return {
    reset,
    touch() {
      state.row = { ...state.row, data: { ...state.row.data, scenario: `${state.row.data.scenario} (touched)` }, updatedAt: stamp() };
    },
    get patches() {
      return state.patches;
    },
    handle(method, path, body) {
      if (path === "/api/characters/alice" && method === "GET") return [200, wire(state.row)];
      if (path === "/api/characters/alice/versions" && method === "GET") return [200, versions()];
      if (path === "/api/characters/alice" && method === "PATCH") return [200, wire(patch(body))];
      return [404, { error: "Not found" }];
    },
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

export function serve(port = 5180) {
  execFileSync(process.execPath, [join(ROOT, "scripts/build.mjs")], { stdio: "inherit" });
  const api = createMockApi();
  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/") {
        res.writeHead(302, { Location: "/dev/harness.html" });
        return res.end();
      }
      if (url.pathname === "/__mock/reset" && req.method === "POST") return api.reset(), send(res, 200, { ok: true });
      if (url.pathname === "/__mock/touch" && req.method === "POST") return api.touch(), send(res, 200, { ok: true });
      if (url.pathname === "/__mock/patches") return send(res, 200, api.patches);
      if (url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" && req.headers["x-marinara-csrf"] !== "1") return send(res, 403, { error: "CSRF header missing" });
        const [status, body] = api.handle(req.method, url.pathname, await readBody(req));
        return send(res, status, body);
      }
      const file = normalize(join(ROOT, decodeURIComponent(url.pathname)));
      if (!file.startsWith(ROOT) || /[/\\]\.|node_modules/.test(file.slice(ROOT.length))) return send(res, 404, { error: "Not found" });
      const content = await readFile(file);
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
      res.end(content);
    } catch (error) {
      if (!res.headersSent) send(res, error.code === "ENOENT" ? 404 : 500, { error: String(error.message ?? error) });
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, api, port: server.address().port })));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { port } = await serve(Number(process.argv[2]) || 5180);
  console.log(`Harness: http://localhost:${port}/dev/harness.html`);
  console.log("Start the helper too: node helper/chardiffer-helper.mjs  (then paste its token via the gear button)");
}
