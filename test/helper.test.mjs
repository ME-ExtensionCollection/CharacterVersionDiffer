// Helper server: auth, origin checks, size cap, and a full session with a fake
// diff tool that edits the right-hand file and exits.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHelper, toolCommand, fileStem } from "../helper/chardiffer-helper.mjs";

let dir;
let helper;
let base;
const TOKEN = "test-token-0123456789abcdef";

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "chardiffer-test-"));
  // Fake diff tool: appends a line to the right-hand file, or leaves it alone with "keep".
  const tool = join(dir, "fake-tool.mjs");
  await writeFile(
    tool,
    `import { appendFileSync, readFileSync } from "node:fs";
const [mode, left, right] = process.argv.slice(2);
if (mode === "edit") appendFileSync(right, "edited\\n");
if (mode === "slow") await new Promise((r) => setTimeout(r, 60000));
process.exit(readFileSync(left, "utf8").length ? 0 : 1);
`,
  );
  await chmod(tool, 0o755);
  helper = await startHelper({
    port: 0,
    token: TOKEN,
    tool: `${process.execPath} ${tool} {leftLabel} {left} {right}`,
    sessionRoot: join(dir, "sessions"),
    origins: ["http://marinara.lan:7860"],
    log: () => {},
  });
  base = `http://127.0.0.1:${helper.port}`;
});

after(async () => {
  await helper?.close();
  await rm(dir, { recursive: true, force: true });
});

const auth = { Authorization: `Bearer ${TOKEN}` };
const post = (body, headers = auth) =>
  fetch(`${base}/sessions`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("needs the token", async () => {
  assert.equal((await fetch(`${base}/health`)).status, 401);
  assert.equal((await fetch(`${base}/health`, { headers: { Authorization: "Bearer wrong" } })).status, 401);
  const ok = await fetch(`${base}/health`, { headers: auth });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ok, true);
});

test("rejects foreign origins, allows loopback and --origin", async () => {
  assert.equal((await fetch(`${base}/health`, { headers: { ...auth, Origin: "https://evil.example" } })).status, 403);
  const local = await fetch(`${base}/health`, { headers: { ...auth, Origin: "http://localhost:7860" } });
  assert.equal(local.status, 200);
  assert.equal(local.headers.get("access-control-allow-origin"), "http://localhost:7860");
  assert.equal((await fetch(`${base}/health`, { headers: { ...auth, Origin: "http://marinara.lan:7860" } })).status, 200);
  const preflight = await fetch(`${base}/sessions`, {
    method: "OPTIONS",
    headers: { Origin: "http://127.0.0.1:7860", "Access-Control-Request-Method": "POST", "Access-Control-Request-Private-Network": "true" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");
  assert.match(preflight.headers.get("access-control-allow-headers"), /authorization/);
});

test("caps the body size and checks the shape", async () => {
  assert.equal((await post({ left: { text: "x".repeat(9 * 1024 * 1024) }, right: { text: "" } })).status, 413);
  assert.equal((await post({ left: { text: 1 }, right: { text: "" } })).status, 400);
});

async function waitClosed(id) {
  for (let i = 0; i < 20; i += 1) {
    const answer = await (await fetch(`${base}/sessions/${id}?wait=5`, { headers: auth })).json();
    if (answer.status === "closed") return answer;
  }
  throw new Error("session never closed");
}

test("returns the edited right-hand text", async () => {
  const response = await post({ title: "Alice / ../../etc", left: { label: "edit", text: "old\n" }, right: { label: "current", text: "new\n" } });
  assert.equal(response.status, 200);
  const { id } = await response.json();
  const result = await waitClosed(id);
  assert.deepEqual(result, { status: "closed", changed: true, text: "new\nedited\n", exitCode: 0 });
  assert.equal(existsSync(join(dir, "sessions", id)), false, "session files are removed");
  assert.equal((await fetch(`${base}/sessions/${id}`, { headers: auth })).status, 404);
});

test("reports an unchanged result", async () => {
  const { id } = await (await post({ left: { label: "keep", text: "a" }, right: { label: "b", text: "b" } })).json();
  const result = await waitClosed(id);
  assert.equal(result.changed, false);
  assert.equal(result.text, "b");
});

test("DELETE stops a running tool", async () => {
  const { id } = await (await post({ left: { label: "slow", text: "a" }, right: { label: "b", text: "b" } })).json();
  const open = await (await fetch(`${base}/sessions/${id}?wait=0`, { headers: auth })).json();
  assert.equal(open.status, "open");
  assert.equal((await fetch(`${base}/sessions/${id}`, { method: "DELETE", headers: auth })).status, 200);
  assert.equal(existsSync(join(dir, "sessions", id)), false);
});

test("tool commands never use a shell", () => {
  const paths = { left: "/r/a b.txt", right: "/r/c.txt", leftLabel: "L; rm -rf ~", rightLabel: "R" };
  assert.deepEqual(toolCommand("meld", paths), ["meld", "--label", "L; rm -rf ~", "--label", "R", "/r/a b.txt", "/r/c.txt"]);
  assert.deepEqual(toolCommand("code", paths), ["code", "--new-window", "--wait", "--diff", "/r/a b.txt", "/r/c.txt"]);
  assert.deepEqual(toolCommand("kdiff3 --x", paths), ["kdiff3", "--x", "/r/a b.txt", "/r/c.txt"]);
});

test("file names are sanitized", () => {
  assert.equal(fileStem("../../etc/passwd", "x"), "etc passwd");
  assert.equal(fileStem("Alice — v1.2 · 2026-11-11 10:00", "x"), "Alice — v1.2 · 2026-11-11 10 00");
  assert.equal(fileStem("...", "fallback"), "fallback");
});
