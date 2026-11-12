#!/usr/bin/env node
// Char Differ helper: opens two card texts in meld (or another diff tool) for
// the Char Differ Marinara extension, waits for you to close it, and hands
// the edited right-hand text back.
//
// Marinara's extension runtimes cannot start programs, so this small server
// does that one job. It listens on 127.0.0.1 only, needs a token on every
// request, accepts text only (never paths or commands), and runs only the tool
// chosen on its own command line.
//
// Usage:
//   node helper/chardiffer-helper.mjs [--port 7869] [--tool meld|code|"<cmd> {left} {right}"]
//                                    [--origin http://my-host:7860]... [--print-token]
//
//   --tool meld   meld --label <left> --label <right> <left> <right>   (default)
//   --tool code   code --new-window --wait --diff <left> <right>
//   --tool "<program> <args…>"   custom; {left} {right} {leftLabel} {rightLabel} are replaced,
//                                words are split on spaces (no shell). It must stay running until
//                                the comparison is closed.
//   --origin      allow another Marinara address (default: any http(s)://localhost, 127.0.0.1 or [::1] port)
//
// The token is created on first run in $XDG_CONFIG_HOME/chardiffer/token
// (~/.config/chardiffer/token). Paste it into Char Differ's settings once.
//
// API (JSON, Authorization: Bearer <token>):
//   GET    /health              { ok, tool, version }
//   POST   /sessions            { title, left: { label, text }, right: { label, text } } -> { id }
//   GET    /sessions/:id?wait=s { status: "open" } or { status: "closed", changed, text, exitCode }
//   DELETE /sessions/:id        stop waiting, close the tool if it's still open, remove the files
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";
const MAX_BODY = 8 * 1024 * 1024;
const MAX_WAIT_S = 30;
const SESSION_TTL_MS = 60 * 60 * 1000;
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

function parseArgs(argv) {
  const opts = { port: 7869, tool: "meld", origins: [], printToken: false, tokenFile: null, sessionRoot: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === "--port") opts.port = Number(next());
    else if (arg === "--tool") opts.tool = next();
    else if (arg === "--origin") opts.origins.push(next().replace(/\/+$/, ""));
    else if (arg === "--print-token") opts.printToken = true;
    else if (arg === "--token-file") opts.tokenFile = next();
    else if (arg === "--session-dir") opts.sessionRoot = next();
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new Error("--port must be 0-65535");
  return opts;
}

/** argv for the diff tool. Never goes through a shell. */
export function toolCommand(tool, { left, right, leftLabel, rightLabel }) {
  if (tool === "meld") return ["meld", "--label", leftLabel, "--label", rightLabel, left, right];
  if (tool === "code") return ["code", "--new-window", "--wait", "--diff", left, right];
  const words = tool.split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error("--tool is empty");
  const values = { "{left}": left, "{right}": right, "{leftLabel}": leftLabel, "{rightLabel}": rightLabel };
  const argv = words.map((word) => word.replace(/\{left\}|\{right\}|\{leftLabel\}|\{rightLabel\}/g, (m) => values[m]));
  if (!words.some((w) => w.includes("{right}"))) argv.push(left, right);
  return argv;
}

async function loadToken(tokenFile) {
  if (existsSync(tokenFile)) {
    const token = (await readFile(tokenFile, "utf8")).trim();
    if (token.length >= 16) return { token, created: false };
  }
  const token = randomBytes(24).toString("base64url");
  await mkdir(join(tokenFile, ".."), { recursive: true, mode: 0o700 });
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  return { token, created: true };
}

/** Safe file name piece: keeps letters, digits and a few marks; never a path. */
export function fileStem(text, fallback) {
  const clean = String(text ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} ._()+,·—-]+/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 80);
  return clean || fallback;
}

export async function startHelper(options = {}) {
  const opts = { port: 7869, tool: "meld", origins: [], ...options };
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const tokenFile = opts.tokenFile ?? join(configHome, "chardiffer", "token");
  const { token, created } = opts.token ? { token: opts.token, created: false } : await loadToken(tokenFile);
  const tokenBytes = Buffer.from(token);
  const sessionRoot = opts.sessionRoot ?? join(process.env.XDG_RUNTIME_DIR || tmpdir(), `chardiffer-${process.getuid?.() ?? "user"}`);
  await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
  await chmod(sessionRoot, 0o700);
  const allowed = new Set(opts.origins);
  const sessions = new Map();
  const log = opts.log ?? ((...args) => console.log(new Date().toISOString().slice(11, 19), ...args));

  const originAllowed = (origin) => !origin || allowed.has(origin) || LOOPBACK_ORIGIN.test(origin);

  function authorized(req) {
    const header = req.headers.authorization ?? "";
    const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7).trim() : "");
    return given.length === tokenBytes.length && timingSafeEqual(given, tokenBytes);
  }

  function send(req, res, status, body) {
    const origin = req.headers.origin;
    const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
    // Unread request body (rejected early): don't keep the connection.
    if (!req.complete) headers.Connection = "close";
    if (origin && originAllowed(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers.Vary = "Origin";
    }
    res.writeHead(status, headers);
    res.end(body === undefined ? undefined : JSON.stringify(body));
  }

  async function readJson(req) {
    if (Number(req.headers["content-length"]) > MAX_BODY) {
      const error = new Error("Request is too large");
      error.status = 413;
      throw error;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) {
        const error = new Error("Request is too large");
        error.status = 413;
        throw error;
      }
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      const error = new Error("Body must be JSON");
      error.status = 400;
      throw error;
    }
  }

  function settle(session) {
    for (const wake of session.waiters.splice(0)) wake();
  }

  async function cleanup(session) {
    clearTimeout(session.expiry);
    sessions.delete(session.id);
    if (session.child && session.status === "open") {
      try {
        session.child.kill("SIGTERM");
      } catch {}
    }
    await rm(session.dir, { recursive: true, force: true });
  }

  async function createSession(body) {
    const side = (value, name) => {
      if (!value || typeof value.text !== "string") {
        const error = new Error(`${name}.text must be a string`);
        error.status = 400;
        throw error;
      }
      return { label: typeof value.label === "string" ? value.label.slice(0, 200) : name, text: value.text };
    };
    const left = side(body?.left, "left");
    const right = side(body?.right, "right");
    const title = typeof body?.title === "string" ? body.title.slice(0, 200) : "";
    const id = randomBytes(12).toString("hex");
    const dir = join(sessionRoot, id);
    await mkdir(dir, { mode: 0o700 });
    const stem = fileStem(title, "card");
    const leftPath = join(dir, `${stem} — ${fileStem(left.label, "previous")}.txt`);
    const rightPath = join(dir, `${stem} — ${fileStem(right.label, "current")}.txt`);
    await writeFile(leftPath, left.text, { mode: 0o400 });
    await writeFile(rightPath, right.text, { mode: 0o600 });

    const argv = toolCommand(opts.tool, { left: leftPath, right: rightPath, leftLabel: left.label, rightLabel: right.label });
    const session = { id, dir, rightPath, original: right.text, status: "open", waiters: [], result: null, child: null };
    sessions.set(id, session);
    session.expiry = setTimeout(() => void cleanup(session), SESSION_TTL_MS);
    session.expiry.unref?.();

    const finish = async (exitCode, error) => {
      if (session.status !== "open") return;
      let text = null;
      try {
        text = await readFile(rightPath, "utf8");
      } catch (readError) {
        error ??= readError;
      }
      session.status = "closed";
      session.result = error && text === null
        ? { status: "closed", error: String(error.message ?? error), exitCode }
        : { status: "closed", changed: text !== session.original, text, exitCode };
      log(`session ${id}: closed (${session.result.error ?? (session.result.changed ? "changed" : "unchanged")})`);
      settle(session);
    };
    try {
      const child = spawn(argv[0], argv.slice(1), { stdio: "ignore", detached: false });
      session.child = child;
      child.once("error", (error) => void finish(null, error));
      child.once("exit", (code) => void finish(code, null));
    } catch (error) {
      await finish(null, error);
    }
    log(`session ${id}: opened ${opts.tool === "meld" || opts.tool === "code" ? opts.tool : argv[0]} for "${title || "card"}"`);
    return session;
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    const origin = req.headers.origin;
    if (!originAllowed(origin)) return send(req, res, 403, { error: `Origin ${origin} is not allowed. Start the helper with --origin ${origin}` });

    if (req.method === "OPTIONS") {
      const headers = {
        "Access-Control-Allow-Origin": origin ?? "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, content-type",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      };
      // Chrome's Private Network Access preflight.
      if (req.headers["access-control-request-private-network"] === "true") headers["Access-Control-Allow-Private-Network"] = "true";
      res.writeHead(204, headers);
      return res.end();
    }
    if (!authorized(req)) return send(req, res, 401, { error: "Wrong or missing token. Copy it from ~/.config/chardiffer/token into Char Differ's settings." });

    if (url.pathname === "/health" && req.method === "GET") return send(req, res, 200, { ok: true, tool: opts.tool, version: VERSION });

    if (url.pathname === "/sessions" && req.method === "POST") {
      const session = await createSession(await readJson(req));
      return send(req, res, 200, { id: session.id });
    }

    const match = /^\/sessions\/([0-9a-f]{24})$/.exec(url.pathname);
    const session = match ? sessions.get(match[1]) : null;
    if (match && !session) return send(req, res, 404, { error: "Session not found (already finished, or the helper restarted)" });
    if (session && req.method === "GET") {
      const wait = Math.min(MAX_WAIT_S, Math.max(0, Number(url.searchParams.get("wait")) || 0));
      if (session.status === "open" && wait > 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, wait * 1000);
          session.waiters.push(() => (clearTimeout(timer), resolve()));
          req.once("close", () => (clearTimeout(timer), resolve()));
        });
      }
      if (res.destroyed) return;
      if (session.status === "open") return send(req, res, 200, { status: "open" });
      const result = session.result;
      await cleanup(session);
      return send(req, res, 200, result);
    }
    if (session && req.method === "DELETE") {
      await cleanup(session);
      settle(session);
      return send(req, res, 200, { ok: true });
    }
    return send(req, res, 404, { error: "Not found" });
  }

  const server = createServer((req, res) =>
    handle(req, res).catch((error) => {
      if (!res.headersSent && !res.destroyed) send(req, res, error.status ?? 500, { error: String(error.message ?? error) });
    }),
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", resolve);
  });
  const port = server.address().port;

  return {
    port,
    token,
    tokenFile,
    created,
    sessions,
    async close() {
      await Promise.all([...sessions.values()].map(cleanup));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`chardiffer-helper: ${error.message}`);
    process.exit(2);
  }
  if (opts.help) {
    const source = await readFile(fileURLToPath(import.meta.url), "utf8");
    console.log(source.split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
    process.exit(0);
  }
  const helper = await startHelper(opts).catch((error) => {
    console.error(`chardiffer-helper: ${error.code === "EADDRINUSE" ? `port ${opts.port} is in use (is the helper already running?)` : error.message}`);
    process.exit(1);
  });
  console.log(`Char Differ helper ${VERSION} on http://127.0.0.1:${helper.port} using ${opts.tool}`);
  if (helper.created || opts.printToken) console.log(`Token (paste into Char Differ's settings): ${helper.token}`);
  console.log(`Token file: ${helper.tokenFile}`);
  console.log("Ctrl+C to stop.");
  const stop = async () => {
    await helper.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
