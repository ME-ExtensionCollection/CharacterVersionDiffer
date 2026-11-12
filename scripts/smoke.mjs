// Browser smoke test: harness (mock Marinara) + real helper + a fake diff tool,
// in headless Chrome. No real Marinara and no GUI diff tool are involved.
//
//   CD_PLAYWRIGHT=/path/to/node_modules/playwright-core   (default: import "playwright-core")
//   CD_CHROME=/usr/bin/google-chrome-stable              (default: Playwright's own browser)
//   CD_SHOTS=/some/dir                                   (optional screenshots)
// Usage: node scripts/smoke.mjs
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { serve, ORIGINAL } from "./serve.mjs";
import { startHelper } from "../helper/chardiffer-helper.mjs";

const pw = await import(process.env.CD_PLAYWRIGHT ? pathToFileURL(join(process.env.CD_PLAYWRIGHT, "index.mjs")).href : "playwright-core");
const shots = process.env.CD_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const dir = await mkdtemp(join(tmpdir(), "chardiffer-smoke-"));
const { server, port } = await serve(0);
const BASE = `http://localhost:${port}`;

// Fake diff tool. What it does is read from the "mode" file at each launch.
const modeFile = join(dir, "mode");
const tool = join(dir, "fake-tool.mjs");
await writeFile(
  tool,
  `import { readFileSync, writeFileSync } from "node:fs";
const [left, right] = process.argv.slice(2);
const mode = readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();
const section = (text, name) => {
  const re = new RegExp("### CharDiffer: " + name + " ###\\n([\\\\s\\\\S]*?)\\n(?=### CharDiffer: )");
  return [re, re.exec(text)?.[1]];
};
let text = readFileSync(right, "utf8");
const old = readFileSync(left, "utf8");
const revert = (name) => {
  const [re, value] = section(old, name);
  text = text.replace(re, () => "### CharDiffer: " + name + " ###\\n" + value + "\\n");
};
if (mode === "touch") await fetch(${JSON.stringify(`${BASE}/__mock/touch`)}, { method: "POST" });
if (mode === "revert" || mode === "touch") revert("description");
if (mode === "break") text = text.replace("### CharDiffer: scenario ###\\n", "");
if (mode !== "noop") writeFileSync(right, text);
`,
);
await chmod(tool, 0o755);
const TOKEN = "smoke-token-0123456789abcdef";
const helper = await startHelper({ port: 0, token: TOKEN, tool: `${process.execPath} ${tool} {left} {right}`, sessionRoot: join(dir, "sessions"), log: () => {} });
// A port nothing listens on: open one, note it, close it.
const closedPort = await new Promise((resolve) => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const { port: free } = probe.address();
    probe.close(() => resolve(free));
  });
});
const settings = { helperUrl: `http://127.0.0.1:${helper.port}`, token: TOKEN };

const browser = await pw.chromium.launch({ executablePath: process.env.CD_CHROME || undefined, headless: true });
let failed = 0;

async function withPage(name, fn, { store = settings, allowErrors = null } = {}) {
  await fetch(`${BASE}/__mock/reset`, { method: "POST" });
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  await context.addInitScript((value) => localStorage.setItem("chardiffer-harness-storage", JSON.stringify(value)), store);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !allowErrors?.test(m.text()) && errors.push(m.text()));
  try {
    await page.goto(`${BASE}/dev/harness.html`);
    await page.waitForSelector(".cd-row-meld");
    await fn(page, async (label) => shots && page.screenshot({ path: join(shots, `${name}-${label}.png`) }));
    assert.deepEqual(errors, [], "page errors");
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n${error.stack}`);
    if (shots) await page.screenshot({ path: join(shots, `${name}-failure.png`) }).catch(() => {});
  } finally {
    await context.close();
  }
}

const setMode = (mode) => writeFile(modeFile, mode);
const patches = async () => (await fetch(`${BASE}/__mock/patches`)).json();
const toastText = (page) => page.locator(".cd-toast").last().innerText();

await withPage("buttons", async (page, shot) => {
  assert.equal(await page.locator(".cd-header .cd-meld").count(), 1);
  assert.equal(await page.locator(".cd-header .cd-gear").count(), 1);
  // One saved version: one row button, none on the current card.
  assert.equal(await page.locator(".cd-row-meld").count(), 1);
  assert.equal(await page.locator('[data-version="current:alice"] .cd-row-meld').count(), 0);
  await shot("panel");
});

await withPage("revert-and-save", async (page, shot) => {
  await setMode("revert");
  await page.click(".cd-meld");
  await page.waitForSelector(".cd-dialog");
  await shot("confirm");
  const body = await page.locator(".cd-dialog__body").innerText();
  assert.match(body, /description/);
  assert.doesNotMatch(body, /tags|personality/);
  await page.click(".cd-dialog .cd-btn--primary");
  await page.waitForFunction(() => document.querySelector(".cd-toast")?.textContent.includes("Saved Alice"));
  const [sent] = await patches();
  assert.deepEqual(Object.keys(sent.data), ["description"]);
  assert.equal(sent.data.description, ORIGINAL.description);
  assert.equal(sent.versionSource, "char-differ");
  assert.match(sent.versionReason, /^Merged in meld against v1\.0/);
  // The editor refetch happened and the panel now lists the pre-merge card too.
  await page.waitForFunction(() => document.querySelectorAll(".cd-row-meld").length === 2);
  await shot("saved");
});

await withPage("row-button", async (page) => {
  await setMode("revert");
  await page.click('[data-version="v1"] .cd-row-meld');
  await page.waitForSelector(".cd-dialog");
  await page.click(".cd-dialog .cd-btn--danger");
  await page.waitForFunction(() => document.querySelector(".cd-toast")?.textContent.includes("discarded"));
  assert.deepEqual(await patches(), []);
});

await withPage("no-changes", async (page) => {
  await setMode("noop");
  await page.click(".cd-meld");
  await page.waitForFunction(() => document.querySelector(".cd-toast")?.textContent.includes("No changes saved"));
  assert.deepEqual(await patches(), []);
});

await withPage("broken-marker", async (page, shot) => {
  await setMode("break");
  await page.click(".cd-meld");
  await page.waitForSelector(".cd-dialog");
  await shot("error");
  assert.match(await page.locator(".cd-dialog").innerText(), /Missing section: scenario/);
  // Reopen with the broken text; closing it unchanged is still broken, then discard.
  await setMode("noop");
  await page.click(".cd-dialog .cd-btn--primary");
  await page.waitForFunction(() => document.querySelector(".cd-dialog")?.textContent.includes("Missing section: scenario"));
  await page.click(".cd-dialog .cd-btn--danger");
  await page.waitForFunction(() => document.querySelector(".cd-toast")?.textContent.includes("discarded"));
  assert.deepEqual(await patches(), []);
});

await withPage("conflict", async (page) => {
  await setMode("touch");
  await page.click(".cd-meld");
  await page.waitForSelector(".cd-dialog");
  assert.match(await page.locator(".cd-dialog__title").innerText(), /changed while meld was open/);
  // Second round: compare against the new card, keep the result as is.
  await setMode("noop");
  await page.click(".cd-dialog .cd-btn--primary");
  await page.waitForFunction(() => document.querySelector(".cd-dialog__title")?.textContent.startsWith("Save changes"));
  const body = await page.locator(".cd-dialog__body").innerText();
  // The merged text still has the original scenario, so saving would undo the touch: it's listed.
  assert.match(body, /description/);
  assert.match(body, /scenario/);
  await page.click(".cd-dialog .cd-btn--primary");
  await page.waitForFunction(() => document.querySelector(".cd-toast")?.textContent.includes("Saved Alice"));
  const [sent] = await patches();
  assert.deepEqual(Object.keys(sent.data).sort(), ["description", "scenario"]);
});

await withPage("dirty-editor", async (page) => {
  await page.check("#mock-dirty");
  await page.click(".cd-meld");
  await page.waitForSelector(".cd-toast--error");
  assert.match(await toastText(page), /Save or discard your edits/);
});

await withPage(
  "wrong-token",
  async (page) => {
    await page.click(".cd-meld");
    await page.waitForSelector(".cd-toast--error");
    assert.match(await toastText(page), /Wrong or missing token/);
    await page.click('.cd-toast--error button:text-is("Settings")');
    await page.waitForSelector(".cd-dialog");
    await page.fill(".cd-dialog input[type=password]", TOKEN);
    await page.click(".cd-dialog >> text=Save and test");
    await page.waitForSelector(".cd-dialog >> text=Connected: helper");
    await page.keyboard.press("Escape");
  },
  { store: { ...settings, token: "nope-nope-nope-nope" }, allowErrors: /status of 401/ },
);

await withPage(
  "helper-offline",
  async (page) => {
    await page.click(".cd-meld");
    await page.waitForSelector(".cd-toast--error");
    assert.match(await toastText(page), /isn't answering/);
  },
  { store: { helperUrl: `http://127.0.0.1:${closedPort}`, token: TOKEN }, allowErrors: /Failed to load resource|ERR_CONNECTION_REFUSED/ },
);

await withPage("cleanup", async (page) => {
  await page.evaluate(() => window.__cdHarness.stop());
  assert.equal(await page.locator(".cd-header, .cd-row-meld").count(), 0);
});

await browser.close();
await helper.close();
server.close();
await rm(dir, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
