// Node test suite for QuickCapture/Core/Resources/insert.js.
//
// Runs every case from the shared golden-fixture manifest
// (Tests/QuickCaptureEngineTests/Fixtures/manifest.json — the same manifest the
// Swift suite uses), comparing BYTES against the .expected.md files (this is
// what keeps the CRLF fixture honest), plus focused unit tests for behaviors
// the fixtures do not pin. No npm dependencies: node:test + node:fs only.
//
// Run:  node --test plugins/quick-capture/test/insert.test.mjs   (also run by pnpm test via insert-js.test.ts)
// (paths are resolved relative to this file, so any cwd works)

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

// Paths adjusted for this repo's layout (the Swift repo kept these under QuickCapture/Core/Resources and Tests/QuickCaptureEngineTests/Fixtures).
const insertJsPath = join(here, "..", "resources", "insert.js");
const fixturesDir = join(here, "fixtures");

// insert.js is a CommonJS-style, side-effect-free script defining one global.
const { qc_insert } = require(insertJsPath);

const DEFAULT_CARD = "New idea ✨ #test";

const manifest = JSON.parse(
  readFileSync(join(fixturesDir, "manifest.json"), "utf8"),
);

// --- test-side helpers -----------------------------------------------------

// Split a document into lines the same way insert.js models them:
// { text, term } with term ∈ { "\n", "\r\n", "" }.
function splitLines(text) {
  const lines = [];
  let i = 0;
  while (i < text.length) {
    const j = text.indexOf("\n", i);
    if (j === -1) {
      lines.push({ text: text.slice(i), term: "" });
      break;
    }
    let end = j;
    let term = "\n";
    if (end > i && text.charCodeAt(end - 1) === 13) {
      end -= 1;
      term = "\r\n";
    }
    lines.push({ text: text.slice(i, end), term });
    i = j + 1;
  }
  return lines;
}

// Assert that output = input with exactly `n` lines inserted at ONE position,
// and return the inserted line texts. Compares line TEXTS (terminators are
// covered by the byte-exact fixture comparison).
function assertOneInsertion(inputTexts, outputTexts, n, label) {
  assert.equal(
    outputTexts.length,
    inputTexts.length + n,
    `${label}: expected exactly ${n} inserted line(s), got ${outputTexts.length - inputTexts.length}`,
  );
  let p = 0;
  while (p < inputTexts.length && inputTexts[p] === outputTexts[p]) p++;
  let s = 0;
  while (
    s < inputTexts.length - p &&
    inputTexts[inputTexts.length - 1 - s] === outputTexts[outputTexts.length - 1 - s]
  ) {
    s++;
  }
  assert.equal(
    p + s,
    inputTexts.length,
    `${label}: output is not input with lines inserted at a single position`,
  );
  return outputTexts.slice(p, p + n);
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

// --- manifest: every case, byte-exact ---------------------------------------

test("manifest has cases and every case names an input fixture", () => {
  assert.ok(Array.isArray(manifest.cases));
  assert.ok(manifest.cases.length > 0);
  for (const c of manifest.cases) {
    assert.ok(c.name, "case needs a name");
    assert.ok(typeof c.input === "string", `${c.name}: needs input`);
    assert.ok(typeof c.column === "string", `${c.name}: needs column`);
    if (!c.error) assert.ok(typeof c.expected === "string", `${c.name}: needs expected`);
  }
});

for (const c of manifest.cases) {
  test(`manifest: ${c.name}`, () => {
    const inputBuf = readFileSync(join(fixturesDir, c.input));
    const card = "card" in c ? c.card : DEFAULT_CARD;

    if (c.error) {
      assert.equal(c.error, "columnNotFound", `${c.name}: unknown error kind`);
      assert.throws(
        () => qc_insert(inputBuf.toString("utf8"), c.column, card),
        /QC column not found: Today/,
        `${c.name}: missing column must throw a loud error`,
      );
      return;
    }

    const expectedBuf = readFileSync(join(fixturesDir, c.expected));
    const output = qc_insert(inputBuf.toString("utf8"), c.column, card);
    const outputBuf = Buffer.from(output, "utf8");

    assert.ok(
      outputBuf.equals(expectedBuf),
      `${c.name}: output bytes differ from ${c.expected}\n--- got ---\n${JSON.stringify(output)}\n--- want ---\n${JSON.stringify(expectedBuf.toString("utf8"))}`,
    );

    // One-line-diff invariant: output lines = input lines with exactly the
    // card's line count inserted at one position.
    const inputTexts = splitLines(inputBuf.toString("utf8")).map((l) => l.text);
    const outputTexts = splitLines(output).map((l) => l.text);
    const inserted = assertOneInsertion(
      inputTexts,
      outputTexts,
      card.split("\n").length,
      c.name,
    );
    assert.match(inserted[0], /^- \[ \] /, `${c.name}: first inserted line must be a card line`);
    if (inserted.length > 1) {
      for (const cont of inserted.slice(1)) {
        assert.match(cont, /^  /, `${c.name}: continuation lines must be indented two spaces`);
      }
    }
  });
}

// --- focused unit tests ------------------------------------------------------

test("re-insert safety: inserting the same card twice yields two cards", () => {
  const board = [
    "---",
    "",
    "kanban-plugin: board",
    "",
    "---",
    "",
    "## Today",
    "",
    "- [ ] Existing",
    "",
    "%% kanban:settings",
    "```",
    '{"kanban-plugin":"board","new-card-insertion-method":"prepend"}',
    "```",
    "%%",
    "",
  ].join("\n");

  const once = qc_insert(board, "Today", DEFAULT_CARD);
  const twice = qc_insert(once, "Today", DEFAULT_CARD);

  assert.equal(countOccurrences(twice, `- [ ] ${DEFAULT_CARD}`), 2);
  // duplicate detection belongs to the verifier, not the insert
  assert.equal(countOccurrences(once, `- [ ] ${DEFAULT_CARD}`), 1);
});

test("board with only frontmatter and the target column", () => {
  const board = "---\nkanban-plugin: board\n---\n## Today\n";
  const out = qc_insert(board, "Today", DEFAULT_CARD);
  assert.equal(out, "---\nkanban-plugin: board\n---\n## Today\n- [ ] New idea ✨ #test\n");
});

test("column match is case-sensitive in both directions", () => {
  const board = "## Today\n\n- [ ] a\n";
  assert.throws(() => qc_insert(board, "today", "x"), /QC column not found: today/);
  assert.throws(() => qc_insert(board, "TODAY", "x"), /QC column not found: TODAY/);

  const lower = "## today\n\n- [ ] a\n";
  assert.throws(() => qc_insert(lower, "Today", "x"), /QC column not found: Today/);
  assert.equal(qc_insert(lower, "today", "x"), "## today\n\n- [ ] x\n- [ ] a\n");
});

test("### Today is a deeper heading, never the target — but it terminates a section", () => {
  const board = "%% kanban:settings\n```\n{\"new-card-insertion-method\":\"append\"}\n```\n%%\n## Backlog\n\n- [ ] b\n\n### Today\n\n- [ ] sub\n";
  assert.throws(() => qc_insert(board, "Today", "x"), /QC column not found: Today/);

  // appending into Backlog must stop before the sub-lane
  const out = qc_insert(board, "Backlog", "x");
  assert.equal(
    out,
    "%% kanban:settings\n```\n{\"new-card-insertion-method\":\"append\"}\n```\n%%\n## Backlog\n\n- [ ] b\n- [ ] x\n\n### Today\n\n- [ ] sub\n",
  );
});

test("a depth-2 heading after a deeper heading is still findable", () => {
  const board = "## Backlog\n\n### Deep work\n\n- [ ] sub\n\n## Today\n\n- [ ] t\n";
  const out = qc_insert(board, "Today", "x");
  // no settings block → prepend, before the first non-blank line of Today
  assert.equal(out, "## Backlog\n\n### Deep work\n\n- [ ] sub\n\n## Today\n\n- [ ] x\n- [ ] t\n");
});

test("##Today (no space) is not a column", () => {
  assert.throws(() => qc_insert("##Today\n- [ ] a\n", "Today", "x"), /QC column not found: Today/);
});

test("##Today (no space) is still a section terminator (trimmed form starts with ##)", () => {
  const board = "%% kanban:settings\n```\n{\"new-card-insertion-method\":\"append\"}\n```\n%%\n## Backlog\n\n- [ ] b\n\n##Today\n- [ ] stray\n";
  const out = qc_insert(board, "Backlog", "x");
  assert.equal(
    out,
    "%% kanban:settings\n```\n{\"new-card-insertion-method\":\"append\"}\n```\n%%\n## Backlog\n\n- [ ] b\n- [ ] x\n\n##Today\n- [ ] stray\n",
  );
});

test("column title must match exactly (no prefix matches, trailing #s kept, trailing spaces trimmed)", () => {
  assert.throws(() => qc_insert("## Today extra\n- [ ] a\n", "Today", "x"), /QC column not found: Today/);
  // trailing "#"s are part of the title (not stripped)
  assert.throws(() => qc_insert("## Today #\n- [ ] a\n", "Today", "x"), /QC column not found: Today/);
  // but heading whitespace around the title is trimmed
  assert.equal(
    qc_insert("## Today   \n- [ ] a\n", "Today", "x"),
    "## Today   \n- [ ] x\n- [ ] a\n",
  );
});

test("settings block before the target column does not hide the column", () => {
  const board = [
    "%% kanban:settings",
    "```",
    '{"kanban-plugin":"board","new-card-insertion-method":"append"}',
    "```",
    "%%",
    "## Backlog",
    "",
    "- [ ] B1",
    "",
    "## Today",
    "",
    "- [ ] T1",
    "",
  ].join("\n");

  const intoToday = qc_insert(board, "Today", "x");
  assert.ok(intoToday.endsWith("## Today\n\n- [ ] T1\n- [ ] x\n"));
  assert.ok(intoToday.includes("## Backlog\n\n- [ ] B1\n"));

  // the Backlog section must still end at ## Today
  const intoBacklog = qc_insert(board, "Backlog", "x");
  assert.ok(intoBacklog.includes("## Backlog\n\n- [ ] B1\n- [ ] x\n\n## Today\n\n- [ ] T1\n"));
});

test("a bare %% line outside any settings block terminates a section", () => {
  const board = '%% kanban:settings\n```\n{"new-card-insertion-method":"append"}\n```\n%%\n## Today\n\n- [ ] a\n\n%%\nnote\n';
  const out = qc_insert(board, "Today", "x");
  assert.equal(
    out,
    '%% kanban:settings\n```\n{"new-card-insertion-method":"append"}\n```\n%%\n## Today\n\n- [ ] a\n- [ ] x\n\n%%\nnote\n',
  );
});

test("append at EOF after an unterminated line: previous line gains the dominant terminator, new final line has none", () => {
  const board = '%% kanban:settings\n```\n{"new-card-insertion-method":"append"}\n```\n%%\n## Today\n\n- [ ] last card';
  const out = qc_insert(board, "Today", DEFAULT_CARD);
  assert.equal(
    out,
    '%% kanban:settings\n```\n{"new-card-insertion-method":"append"}\n```\n%%\n## Today\n\n- [ ] last card\n- [ ] New idea ✨ #test',
  );
});

test("append at EOF in a CRLF-dominant file after an unterminated line gains \\r\\n", () => {
  const board = '%% kanban:settings\r\n```\r\n{"new-card-insertion-method":"append"}\r\n```\r\n%%\r\n## Today\r\n\r\n- [ ] last card';
  const out = qc_insert(board, "Today", DEFAULT_CARD);
  assert.equal(
    out,
    '%% kanban:settings\r\n```\r\n{"new-card-insertion-method":"append"}\r\n```\r\n%%\r\n## Today\r\n\r\n- [ ] last card\r\n- [ ] New idea ✨ #test',
  );
});

test("file with no newline at all: dominant terminator is \\n", () => {
  const out = qc_insert("## Today", "Today", "x");
  assert.equal(out, "## Today\n- [ ] x");
});

test("multiline card: first line gets the checkbox, the rest get two-space continuation", () => {
  const out = qc_insert("## Today\n\n- [ ] a\n", "Today", "one\ntwo\nthree");
  assert.equal(out, "## Today\n\n- [ ] one\n  two\n  three\n- [ ] a\n");
});

test("unknown new-card-insertion-method value falls back to prepend", () => {
  const board = '%% kanban:settings\n```\n{"new-card-insertion-method":"side-load"}\n```\n%%\n## Today\n\n- [ ] a\n';
  const out = qc_insert(board, "Today", "x");
  assert.equal(
    out,
    '%% kanban:settings\n```\n{"new-card-insertion-method":"side-load"}\n```\n%%\n## Today\n\n- [ ] x\n- [ ] a\n',
  );
});

test("empty column must never insert into another column", () => {
  const board = "## Backlog\n\n- [ ] b\n";
  assert.throws(() => qc_insert(board, "Today", "x"), /QC column not found: Today/);
  assert.equal(board, "## Backlog\n\n- [ ] b\n"); // input untouched, nothing written anywhere
});
