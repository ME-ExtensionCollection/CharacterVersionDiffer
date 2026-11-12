// Char Differ: card <-> text. No DOM and no Marinara globals, so
// test/core.test.mjs can load this file on its own in a Node vm.
//
// A card becomes plain text with one section per field, so meld can diff
// prose line by line instead of one long escaped JSON line:
//
//   ### CharDiffer: description ###
//   ...the field, verbatim...
//   ### CharDiffer: alternate_greetings #1 ###
//   ...
//   ### CharDiffer: tags ###
//   one tag per line
//   ### CharDiffer: extensions (JSON) ###
//   { pretty JSON }
//
// Text fields round-trip exactly. JSON sections come last, so a tool that
// drops the file's final newline only touches JSON whitespace.

const CDCore = (() => {
  "use strict";

  const MARKER = /^### CharDiffer: (.+) ###$/;
  const marker = (name) => `### CharDiffer: ${name} ###`;
  const JSON_SUFFIX = " (JSON)";
  const GREETING = /^alternate_greetings #(\d+)$/;

  // Card V2 text fields, in the order they read best (packages/shared/src/schemas/character.schema.ts).
  const TEXT_FIELDS = Object.freeze([
    "name",
    "description",
    "personality",
    "scenario",
    "first_mes",
    "mes_example",
    "summary",
    "system_prompt",
    "post_history_instructions",
    "creator_notes",
    "creator",
    "character_version",
  ]);
  const JSON_FIELDS = Object.freeze(["character_book", "extensions"]);
  // alternate_greetings goes right after first_mes.
  const GREETINGS_AFTER = "first_mes";

  const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);

  class CardTextError extends Error {}

  /** Stable JSON: object keys sorted, so key order never shows up as a change. */
  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (isRecord(value)) {
      const out = {};
      for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
      return out;
    }
    return value;
  }
  const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

  /**
   * Which sections a pair of cards gets. Both sides use the same layout, so a
   * field that only one card has still lines up in the diff.
   */
  function layout(...cards) {
    const keys = new Set();
    for (const card of cards) for (const key of Object.keys(card ?? {})) keys.add(key);
    const extraText = [];
    const extraJson = [];
    for (const key of [...keys].sort()) {
      if (TEXT_FIELDS.includes(key) || JSON_FIELDS.includes(key) || key === "alternate_greetings" || key === "tags") continue;
      // A field that is text on every card that has it is a text section.
      const texts = cards.every((card) => !card || !(key in card) || typeof card[key] === "string");
      (texts ? extraText : extraJson).push(key);
    }
    // Tags go one per line unless a tag can't survive that (newline, edge spaces, empty).
    const lineSafe = (tag) => typeof tag === "string" && !!tag && tag === tag.trim() && !tag.includes("\n");
    const tagsJson = cards.some((card) => Array.isArray(card?.tags) && !card.tags.every(lineSafe));
    return { extraText, extraJson, tagsJson };
  }

  function checkText(name, text) {
    for (const line of text.split("\n")) {
      if (MARKER.test(line)) {
        throw new CardTextError(`The ${name} field has a line that looks like a Char Differ section marker ("${line}"), so it can't be shown safely.`);
      }
    }
    return text;
  }

  /**
   * One card as text. `others` are the cards it will be compared with (for the
   * shared layout). `title` goes in the header comment.
   */
  function serialize(card, { others = [], title = "" } = {}) {
    if (!isRecord(card)) throw new CardTextError("Card data is missing.");
    const { extraText, extraJson, tagsJson } = layout(card, ...others);
    const parts = [];
    const text = (key, value) => parts.push(marker(key), checkText(key, typeof value === "string" ? value : ""));
    const json = (key, value) => parts.push(marker(key + JSON_SUFFIX), JSON.stringify(stable(value ?? null), null, 2));

    for (const key of TEXT_FIELDS) {
      text(key, card[key]);
      if (key === GREETINGS_AFTER) {
        const greetings = Array.isArray(card.alternate_greetings) ? card.alternate_greetings : [];
        greetings.forEach((greeting, i) => text(`alternate_greetings #${i + 1}`, greeting));
      }
    }
    const tags = Array.isArray(card.tags) ? card.tags : [];
    if (tagsJson) json("tags", tags);
    else parts.push(marker("tags"), tags.join("\n"));
    for (const key of extraText) text(key, card[key]);
    for (const key of [...extraJson, ...JSON_FIELDS]) json(key, card[key]);

    const header = [
      `# Char Differ${title ? `: ${title.replace(/\s+/g, " ")}` : ""}`,
      "# Edit the right-hand file, save it (Ctrl+S), then close meld. Lines above the first ### marker are ignored.",
      "# Keep the ### CharDiffer: … ### lines. Delete or add alternate_greetings sections to remove or add greetings.",
      "",
    ];
    return `${header.join("\n")}${parts.join("\n")}\n`;
  }

  /**
   * Text back to card fields. `base` is the card the text was made from and
   * `others` the cards it was compared with (same as for serialize); they
   * decide which sections are expected. Returns the full new card data.
   */
  function parse(text, base, { others = [] } = {}) {
    if (typeof text !== "string") throw new CardTextError("No text to read.");
    if (!isRecord(base)) throw new CardTextError("Card data is missing.");
    const lines = text.split("\n");
    if (text.endsWith("\n")) lines.pop();

    const sections = [];
    for (const line of lines) {
      const match = MARKER.exec(line);
      if (match) sections.push({ name: match[1], lines: [] });
      else if (sections.length) sections[sections.length - 1].lines.push(line);
    }
    if (!sections.length) throw new CardTextError("No ### CharDiffer sections were found. Was the file saved empty?");

    const { extraText, extraJson, tagsJson } = layout(base, ...others);
    const textKeys = new Set([...TEXT_FIELDS, ...extraText]);
    const jsonKeys = new Set([...JSON_FIELDS, ...extraJson, ...(tagsJson ? ["tags"] : [])]);
    const seen = new Set();
    const greetings = [];
    const out = { ...base };

    for (const { name, lines: body } of sections) {
      const value = body.join("\n");
      if (GREETING.test(name)) {
        greetings.push(value);
        continue;
      }
      if (seen.has(name)) throw new CardTextError(`Section "${name}" appears twice.`);
      seen.add(name);
      if (name === "tags" && !tagsJson) {
        const tags = [];
        for (const line of body) {
          const tag = line.trim();
          if (tag && !tags.includes(tag)) tags.push(tag);
        }
        out.tags = tags;
      } else if (name.endsWith(JSON_SUFFIX) && jsonKeys.has(name.slice(0, -JSON_SUFFIX.length))) {
        const key = name.slice(0, -JSON_SUFFIX.length);
        try {
          out[key] = JSON.parse(value.trim() || "null");
        } catch (error) {
          throw new CardTextError(`Section "${name}" is not valid JSON: ${error.message}`);
        }
        if (key === "tags" && !(Array.isArray(out.tags) && out.tags.every((tag) => typeof tag === "string"))) {
          throw new CardTextError(`Section "${name}" must be a JSON list of strings.`);
        }
        if (key === "extensions" && !isRecord(out[key])) throw new CardTextError(`Section "${name}" must be a JSON object.`);
        if (key === "character_book" && out[key] !== null && !isRecord(out[key])) {
          throw new CardTextError(`Section "${name}" must be a JSON object or null.`);
        }
      } else if (textKeys.has(name)) {
        out[name] = value;
      } else {
        throw new CardTextError(`Unknown section "${name}". Section marker lines must stay as they were.`);
      }
    }

    const expected = [...(tagsJson ? [] : ["tags"]), ...textKeys, ...[...jsonKeys].map((key) => key + JSON_SUFFIX)];
    const missing = expected.filter((name) => !seen.has(name));
    if (missing.length) throw new CardTextError(`Missing section${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Keep every ### marker line.`);
    out.alternate_greetings = greetings;
    if (typeof out.name !== "string" || !out.name.trim()) throw new CardTextError("The name can't be empty.");
    return out;
  }

  /** Top-level keys of `next` that differ from `current`, as the PATCH body's `data`. */
  function changes(current, next) {
    const patch = {};
    const keys = new Set([...Object.keys(current ?? {}), ...Object.keys(next ?? {})]);
    for (const key of keys) {
      if (!(key in next)) continue;
      const before = current?.[key];
      const after = next[key];
      // A text field the card never had and is still empty is not a change.
      if (before === undefined && (after === "" || (Array.isArray(after) && !after.length))) continue;
      if (!same(before, after)) patch[key] = after;
    }
    return patch;
  }

  /**
   * Keys deleted inside objects of a patch. Marinara deep-merges `extensions`
   * and `character_book` (mergeNestedRecord in characters.storage.ts), so a
   * removed key there would stay. Arrays are replaced whole, so they're fine.
   */
  function removedNestedKeys(current, patch) {
    const removed = [];
    const walk = (before, after, path) => {
      if (!isRecord(before) || !isRecord(after)) return;
      for (const key of Object.keys(before)) {
        if (!(key in after)) removed.push(`${path}.${key}`);
        else walk(before[key], after[key], `${path}.${key}`);
      }
    };
    for (const key of Object.keys(patch)) walk(current?.[key], patch[key], key);
    return removed;
  }

  /** Short label for a version row: "v1.3 · 2026-11-11 14:02 · manual". */
  function versionLabel(version) {
    if (!version) return "";
    const bits = [];
    if (version.isCurrent) bits.push("current");
    else if (version.version) bits.push(`v${version.version}`);
    else if (version.revision) bits.push(`revision ${version.revision}`);
    const when = Date.parse(version.createdAt ?? "");
    if (Number.isFinite(when)) {
      const d = new Date(when);
      const pad = (n) => String(n).padStart(2, "0");
      bits.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`);
    }
    if (!version.isCurrent && version.source) bits.push(version.source);
    return bits.join(" · ");
  }

  /** Human list of changed fields for the confirm dialog. */
  function describeChanges(current, patch) {
    return Object.keys(patch).map((key) => {
      if (key === "alternate_greetings") {
        const before = Array.isArray(current?.alternate_greetings) ? current.alternate_greetings.length : 0;
        const after = patch.alternate_greetings.length;
        return before === after ? "alternate greetings (edited)" : `alternate greetings (${before} → ${after})`;
      }
      if (key === "tags") {
        const before = new Set(current?.tags ?? []);
        const after = new Set(patch.tags);
        const added = [...after].filter((tag) => !before.has(tag));
        const gone = [...before].filter((tag) => !after.has(tag));
        const bits = [...added.map((tag) => `+${tag}`), ...gone.map((tag) => `−${tag}`)];
        return `tags${bits.length ? ` (${bits.join(", ")})` : " (reordered)"}`;
      }
      return key.replace(/_/g, " ");
    });
  }

  return Object.freeze({
    CardTextError,
    serialize,
    parse,
    changes,
    removedNestedKeys,
    versionLabel,
    describeChanges,
    same,
  });
})();
