// Port of ChangelogNoteRenderer.swift: one quarter note = header + generated
// banner + every entry newest first. Deterministic given `now` (and an
// optional time zone, for tests). Notes are pure re-renders of the store, so
// the banner warns that manual edits are overwritten.
import { formatEntryDate, formatGenerated, type ReleaseEntry } from './model.js';

const byNewest = (a: ReleaseEntry, b: ReleaseEntry): number =>
  a.date !== b.date ? (a.date > b.date ? -1 : 1) : a.title < b.title ? -1 : a.title > b.title ? 1 : 0;

/** "Nov 10, 2026 · EDIFACT EDI Connector · [source](…)": the product drops
 *  out when it is the whole title. */
function metadataLine(e: ReleaseEntry): string {
  const parts = [formatEntryDate(e.date)];
  if (e.product !== e.title) parts.push(e.product);
  parts.push(`[source](${e.anchor === '' ? e.pageURL : `${e.pageURL}#${e.anchor}`})`);
  return parts.join(' · ');
}

export function renderNote(quarterKey: string, entries: readonly ReleaseEntry[], now: Date = new Date(), timeZone?: string): string {
  const sorted = [...entries].sort(byNewest);
  const lines = [
    `# MuleSoft Release Notes — ${quarterKey.replace('-Q', ' Q')}`,
    '',
    `_Generated ${formatGenerated(now, timeZone)} · ${sorted.length} entries · auto-generated from the WorkBar MuleSoftChangelog database — do not edit; this file is regenerated._`,
    '',
  ];
  sorted.forEach((e, i) => {
    lines.push(`## ${e.title}`, '', `_${metadataLine(e)}_`, '');
    if (e.bodyMarkdown !== '') lines.push(e.bodyMarkdown, '');
    if (i < sorted.length - 1) lines.push('---', '');
  });
  return lines.join('\n');
}
