// QuickCapture board insert snippet.
//
// Self-contained by contract: no imports, no dependencies, no top-level side
// effects, function declarations only. It runs in two contexts:
//   1. Node (CommonJS) — required by Tests/insert.test.mjs.
//   2. `obsidian eval` — the Swift CliWriter concatenates an IIFE invocation
//      after this source and executes it inside the running Obsidian app via
//      app.vault.process(). Nothing here may run on load.
//
// qc_insert(content, column, cardText) returns the new full board content and
// throws Error("QC column not found: <column>") when the column is absent.
//
// Algorithm (see markdown/plans/SPEC.md "Board insert algorithm (AUTHORITATIVE)"; the golden
// fixtures in Tests/QuickCaptureEngineTests/Fixtures are the executable spec):
//   - Line-based model: each line carries its terminator ("\n" or "\r\n"; the
//     final line may have none). A lone "\r" not followed by "\n" is ordinary
//     line content.
//   - Target: the first depth-2 heading ("##" + whitespace + title, next char
//     not "#", title case-sensitive and whitespace-trimmed, trailing "#"s NOT
//     stripped) whose title equals `column` exactly. Lines starting with "###"
//     (3 or more "#") are deeper headings: never the target, but they do
//     terminate a section. Lines whose trimmed form merely starts with "##"
//     (e.g. "##Today", no space) are never the target either, but they also
//     terminate a section.
//   - Section: from the line after the heading up to (exclusive) the first line
//     whose trimmed form starts with "##", starts with "%% kanban:settings",
//     is exactly "%%", or EOF.
//   - Insertion method: JSON between the "%% kanban:settings" line and the next
//     "%%" line (fences stripped). "new-card-insertion-method" === "append"
//     means append; anything else, missing, or malformed JSON means prepend
//     (obsidian-kanban's default).
//   - Insert position: append → after the last non-blank line of the section;
//     prepend → before the first non-blank line. Empty section → insert right
//     after the heading line, skipping ONE following blank line if present.
//   - Card lines: first line "- [ ] " + first card-text line; every subsequent
//     card-text line is prefixed with two spaces.
//   - Terminators: the inserted lines take the terminator of the line
//     immediately before the insert point. When inserting at EOF after an
//     unterminated line, that previous line gains the file's dominant
//     terminator (more common of "\r\n" vs "\n"; "\n" on tie or when the file
//     has no newline at all) and the new final line gets no terminator.

function qc_insert(content, column, cardText) {
  "use strict";

  if (typeof content !== "string") throw new Error("QC insert: content must be a string");
  if (typeof column !== "string") throw new Error("QC insert: column must be a string");
  if (typeof cardText !== "string") throw new Error("QC insert: cardText must be a string");

  function isWs(ch) {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" ||
      ch === "\f" || ch === "\v" || ch === " " ||
      (typeof ch === "string" && /\s/.test(ch));
  }

  // Split content into { text, term } lines. term is "\n", "\r\n", or "" for
  // an unterminated final line. "a\n" is a single line with term "\n" — no
  // trailing empty line is invented.
  function splitLines(text) {
    var lines = [];
    var n = text.length;
    var i = 0;
    while (i < n) {
      var j = text.indexOf("\n", i);
      if (j === -1) {
        lines.push({ text: text.slice(i), term: "" });
        break;
      }
      var end = j;
      var term = "\n";
      if (end > i && text.charCodeAt(end - 1) === 13) { // "\r" immediately before "\n"
        end -= 1;
        term = "\r\n";
      }
      lines.push({ text: text.slice(i, end), term: term });
      i = j + 1;
    }
    return lines;
  }

  function isBlank(lineText) {
    return lineText.trim() === "";
  }

  // Depth-2 heading title of a line, or null when the line is not a depth-2
  // heading. Requires "##" followed by whitespace and not a third "#".
  function headingTitle(lineText) {
    var t = lineText.trim();
    if (t.length < 3) return null; // bare "##" (or less) has no whitespace after "##"
    if (t.charAt(0) !== "#" || t.charAt(1) !== "#") return null;
    if (t.charAt(2) === "#") return null; // "###" or deeper: never the target
    if (!isWs(t.charAt(2))) return null; // "##Today": not a heading
    return t.slice(2).trim(); // trailing "#"s are part of the title
  }

  // A section ends at any heading-shaped line, the settings block, or a bare
  // settings-closer line.
  function isSectionEnd(lineText) {
    var t = lineText.trim();
    return t.indexOf("##") === 0 ||
      t.indexOf("%% kanban:settings") === 0 ||
      t === "%%";
  }

  // Read new-card-insertion-method from the settings block. "append" → append;
  // anything else (including missing settings, malformed JSON, unknown values)
  // → prepend, obsidian-kanban's default.
  function settingsMethod(lines) {
    var start = -1;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].text.trim().indexOf("%% kanban:settings") === 0) {
        start = i;
        break;
      }
    }
    if (start === -1) return "prepend";
    var body = [];
    for (var i = start + 1; i < lines.length; i++) {
      var t = lines[i].text.trim();
      if (t === "%%") break;
      if (t.indexOf("```") === 0) continue; // strip ``` fence lines
      body.push(lines[i].text);
    }
    try {
      var obj = JSON.parse(body.join("\n"));
      if (obj !== null && typeof obj === "object" &&
        obj["new-card-insertion-method"] === "append") {
        return "append";
      }
    } catch (e) {
      // malformed settings JSON is not an error — fall back to prepend
    }
    return "prepend";
  }

  // Whichever of "\r\n" vs "\n" occurs more often; "\n" on tie or when the
  // file contains no newline at all.
  function dominantTerm(text) {
    var crlf = 0;
    var lf = 0;
    for (var i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) {
        if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
        else lf++;
      }
    }
    return crlf > lf ? "\r\n" : "\n";
  }

  // Empty-section rule: insert after the heading line, skipping ONE following
  // blank line if present (both methods).
  function emptySectionInsertIndex() {
    var b = headingIdx + 1;
    if (b < lines.length && isBlank(lines[b].text)) return b + 1;
    return b;
  }

  var lines = splitLines(content);

  // --- find the target column (first depth-2 heading with an exact title) ---
  var headingIdx = -1;
  for (var i = 0; i < lines.length; i++) {
    var title = headingTitle(lines[i].text);
    if (title !== null && title === column) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx === -1) throw new Error("QC column not found: " + column);

  // --- section bounds ---
  var end = lines.length;
  for (var i = headingIdx + 1; i < lines.length; i++) {
    if (isSectionEnd(lines[i].text)) {
      end = i;
      break;
    }
  }

  // --- insertion method ---
  var method = settingsMethod(lines);

  // --- insert position ---
  var insertIdx;
  if (method === "append") {
    var last = -1;
    for (var i = headingIdx + 1; i < end; i++) {
      if (!isBlank(lines[i].text)) last = i;
    }
    insertIdx = last === -1 ? emptySectionInsertIndex() : last + 1;
  } else {
    var first = -1;
    for (var i = headingIdx + 1; i < end; i++) {
      if (!isBlank(lines[i].text)) {
        first = i;
        break;
      }
    }
    insertIdx = first === -1 ? emptySectionInsertIndex() : first;
  }

  // --- terminators for the inserted lines ---
  var term;
  var finalInsertedLineHasTerm = true;
  if (insertIdx === 0) {
    // Impossible with a heading present; spec default.
    term = "\n";
  } else if (insertIdx >= lines.length) {
    // Inserting at EOF. If the last line is unterminated, it gains the file's
    // dominant terminator and the new final line gets none.
    var lastLine = lines[lines.length - 1];
    if (lastLine.term === "") {
      term = dominantTerm(content);
      lastLine.term = term;
      finalInsertedLineHasTerm = false;
    } else {
      term = lastLine.term;
    }
  } else {
    // Interior insert: the previous line always has a terminator (only the
    // final line of the file can be unterminated). Defensive fallback to "\n".
    term = lines[insertIdx - 1].term || "\n";
  }

  // --- build the card lines ---
  var cardParts = cardText.split("\n");
  var inserted = [];
  for (var k = 0; k < cardParts.length; k++) {
    var text = k === 0 ? "- [ ] " + cardParts[k] : "  " + cardParts[k];
    var hasTerm = k === cardParts.length - 1 ? finalInsertedLineHasTerm : true;
    inserted.push({ text: text, term: hasTerm ? term : "" });
  }

  // --- splice and reassemble ---
  var out = lines.slice(0, insertIdx)
    .concat(inserted, lines.slice(insertIdx));
  var result = "";
  for (var i = 0; i < out.length; i++) {
    result += out[i].text + out[i].term;
  }
  return result;
}

if (typeof module !== "undefined") module.exports = { qc_insert };
