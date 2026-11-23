// Port of ChangelogNoteRenderer.swift: one quarter note = header + generated
// banner + every entry newest-first. Notes are pure re-renders of the store,
// so a later run clobbers manual edits, and the banner says so.
import type { ChangelogEntry } from './model.js';
import { formatEntryDate, formatGenerated } from './model.js';

export function renderNote(quarterKey: string, entries: readonly ChangelogEntry[], now: Date = new Date()): string {
  const sorted = [...entries].sort((a, b) => (a.date === b.date ? (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) : a.date > b.date ? -1 : 1));
  const lines: string[] = [
    `# Workato Changelog — ${quarterKey.replace('-Q', ' Q')}`,
    '',
    `_Generated ${formatGenerated(now)} · ${sorted.length} entries · auto-generated from the WorkBar WorkatoChangelog database — do not edit; this file is regenerated._`,
    '',
  ];
  sorted.forEach((e, i) => {
    lines.push(`## ${e.title}`, '', `_${metadataLine(e)}_`, '');
    if (e.bodyMarkdown) lines.push(e.bodyMarkdown, '');
    if (i < sorted.length - 1) lines.push('---', '');
  });
  return lines.join('\n');
}

/** "Nov 3, 2026 · Released · API platform, SAP". Empty parts drop out. */
function metadataLine(e: ChangelogEntry): string {
  const parts = [formatEntryDate(e.date)];
  if (e.badge) parts.push(e.badge);
  if (e.categories.length) parts.push(e.categories.join(', '));
  return parts.join(' · ');
}
