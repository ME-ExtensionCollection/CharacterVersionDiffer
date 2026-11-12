// Card <-> text serializer. Loads extension/src/core.js the way Marinara does
// (plain script, no modules).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CDCore = vm.runInThisContext(`(() => {\n${readFileSync(join(ROOT, "extension/src/core.js"), "utf8")}\n;return CDCore;\n})()`, {
  filename: "core.js",
});

function card(overrides = {}) {
  return {
    name: "Alice",
    summary: "",
    description: "Alice is an elf.\n\nShe lives in a tree.\n",
    personality: "curious, kind",
    scenario: "",
    first_mes: "*waves* Hello!\r\nWindows line ending above.",
    mes_example: "<START>\n{{user}}: hi\n{{char}}: hi\n\n\n",
    creator_notes: "Made for testing 🌲 ünïcødé",
    system_prompt: "",
    post_history_instructions: "",
    tags: ["Elf", "Fantasy", "two words"],
    creator: "Kestrel",
    character_version: "1.2",
    alternate_greetings: ["Second greeting", "", "Third\nmulti-line"],
    extensions: { talkativeness: "0.5", fav: true, depth_prompt: { depth: 4, prompt: "x", role: "system" } },
    character_book: null,
    ...overrides,
  };
}

const roundTrip = (data, others = []) => CDCore.parse(CDCore.serialize(data, { others }), data, { others });

test("round-trips a card exactly", () => {
  const data = card();
  assert.deepEqual(roundTrip(data), data);
});

test("round-trips empty and odd values", () => {
  const data = card({ description: "", alternate_greetings: [], tags: [], first_mes: "\n", scenario: "\n\nx" });
  assert.deepEqual(roundTrip(data), data);
});

test("round-trips extra passthrough fields and a lorebook", () => {
  const data = card({
    world: "Midgard",
    extra_list: [1, 2],
    character_book: { name: "Book", entries: [{ keys: ["a"], content: "line1\nline2", enabled: true }] },
  });
  assert.deepEqual(roundTrip(data), data);
});

test("survives a lost final newline", () => {
  const data = card();
  const text = CDCore.serialize(data);
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(CDCore.parse(text.slice(0, -1), data), data);
});

test("both sides share one layout", () => {
  const left = card({ world: "Old world" });
  const right = card({ alternate_greetings: ["Only one"] });
  const leftText = CDCore.serialize(left, { others: [right] });
  const rightText = CDCore.serialize(right, { others: [left] });
  assert.match(rightText, /### CharDiffer: world ###\n\n/);
  const parsed = CDCore.parse(rightText, right, { others: [left] });
  // "world" was empty on the right and missing on the card: not a change.
  assert.deepEqual(CDCore.changes(right, parsed), {});
  assert.ok(leftText.includes("Old world"));
});

test("edits become a minimal patch", () => {
  const data = card();
  const text = CDCore.serialize(data)
    .replace("She lives in a tree.", "She lives in a castle.")
    .replace("### CharDiffer: alternate_greetings #2 ###\n\n", "")
    .replace("two words\n", "two words\nNew Tag\n");
  const next = CDCore.parse(text, data);
  const patch = CDCore.changes(data, next);
  assert.deepEqual(Object.keys(patch).sort(), ["alternate_greetings", "description", "tags"]);
  assert.equal(patch.description, "Alice is an elf.\n\nShe lives in a castle.\n");
  assert.deepEqual(patch.alternate_greetings, ["Second greeting", "Third\nmulti-line"]);
  assert.deepEqual(patch.tags, ["Elf", "Fantasy", "two words", "New Tag"]);
  assert.deepEqual(CDCore.describeChanges(data, patch).sort(), ["alternate greetings (3 → 2)", "description", "tags (+New Tag)"]);
});

test("adding a greeting section adds a greeting", () => {
  const data = card();
  const text = CDCore.serialize(data).replace("### CharDiffer: mes_example ###", "### CharDiffer: alternate_greetings #9 ###\nNew one\n### CharDiffer: mes_example ###");
  assert.deepEqual(CDCore.parse(text, data).alternate_greetings, [...data.alternate_greetings, "New one"]);
});

test("JSON key order is not a change", () => {
  const data = card();
  const reordered = { ...data, extensions: { depth_prompt: { role: "system", prompt: "x", depth: 4 }, fav: true, talkativeness: "0.5" } };
  assert.deepEqual(CDCore.changes(data, reordered), {});
});

test("reports keys deleted inside merged objects", () => {
  const data = card();
  const text = CDCore.serialize(data).replace(/\n {2}"fav": true,/, "");
  const patch = CDCore.changes(data, CDCore.parse(text, data));
  assert.deepEqual(Object.keys(patch), ["extensions"]);
  assert.deepEqual(CDCore.removedNestedKeys(data, patch), ["extensions.fav"]);
});

test("refuses a field that contains a marker line", () => {
  assert.throws(() => CDCore.serialize(card({ description: "a\n### CharDiffer: name ###\nb" })), CDCore.CardTextError);
});

test("odd tags switch to a JSON section", () => {
  const data = card({ tags: ["ok", " spaced ", "multi\nline"] });
  const text = CDCore.serialize(data);
  assert.match(text, /### CharDiffer: tags \(JSON\) ###/);
  assert.deepEqual(roundTrip(data), data);
});

test("parse errors are clear", () => {
  const data = card();
  const text = CDCore.serialize(data);
  assert.throws(() => CDCore.parse(text.replace("### CharDiffer: scenario ###\n", ""), data), /Missing section: scenario/);
  assert.throws(() => CDCore.parse(text.replace("### CharDiffer: scenario ###", "### CharDiffer: scenery ###"), data), /Unknown section "scenery"/);
  assert.throws(() => CDCore.parse(text.replace('"fav": true', '"fav": tru'), data), /not valid JSON/);
  assert.throws(() => CDCore.parse(text.replace("### CharDiffer: name ###\nAlice", "### CharDiffer: name ###\n  "), data), /name can't be empty/);
  assert.throws(() => CDCore.parse("", data), /No ### CharDiffer sections/);
  assert.throws(() => CDCore.parse(`${text}### CharDiffer: name ###\nBob\n`, data), /appears twice/);
});

test("header lines before the first marker are ignored", () => {
  const data = card();
  const text = CDCore.serialize(data, { title: "Alice — v1.2" });
  assert.ok(text.startsWith("# Char Differ: Alice — v1.2\n"));
  assert.deepEqual(CDCore.parse(`random note\n${text}`, data), data);
});

test("version labels", () => {
  assert.equal(CDCore.versionLabel({ isCurrent: true, createdAt: "bad" }), "current");
  assert.match(CDCore.versionLabel({ version: "1.3", createdAt: "2026-11-11T10:00:00Z", source: "manual" }), /^v1\.3 · 2026-11-1\d \d\d:\d\d · manual$/);
});
