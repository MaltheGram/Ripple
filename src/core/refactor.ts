import type { FilePatch } from './types';

const TOKEN = /[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|\S/g;
const IDENT = /^[A-Za-z_$][\w$]*$/;
/** A rename only counts as a refactor when it shows up in this many files. One-off swaps can be real behavior changes. */
export const MIN_REFACTOR_FILES = 3;

/**
 * Identifier renames that fully explain a file's changes, e.g. `["fooBar → fooBaz"]`.
 * Returns undefined when any changed line differs by more than identifier swaps.
 * Needs `-U0` hunks, where changed lines pair up 1:1 when old and new line counts match.
 */
export function renamesInFile(p: FilePatch): string[] | undefined {
  if (p.change === 'added' || p.change === 'deleted' || p.binary || p.hunks.length === 0) return undefined;
  const renames = new Map<string, string>();

  for (const h of p.hunks) {
    if (h.oldLines !== h.newLines || h.oldLines === 0) return undefined;
    const removed = h.lines.filter((l) => l[0] === '-').map((l) => l.slice(1));
    const added = h.lines.filter((l) => l[0] === '+').map((l) => l.slice(1));
    if (removed.length !== added.length) return undefined;

    for (let i = 0; i < removed.length; i++) {
      const a = removed[i].match(TOKEN) ?? [];
      const b = added[i].match(TOKEN) ?? [];
      if (a.length !== b.length) return undefined;
      for (let t = 0; t < a.length; t++) {
        if (a[t] === b[t]) continue;
        if (!IDENT.test(a[t]) || !IDENT.test(b[t])) return undefined;
        const prev = renames.get(a[t]);
        if (prev !== undefined && prev !== b[t]) return undefined;
        renames.set(a[t], b[t]);
      }
    }
  }
  if (renames.size === 0) return undefined;
  return [...renames].map(([a, b]) => `${a} → ${b}`).sort();
}

/**
 * Files whose changes are only renames that repeat across at least MIN_REFACTOR_FILES files.
 * Returns path → the file's rename key (e.g. "fooBar → fooBaz"), used to show them as one item.
 */
export function detectRefactors(patches: FilePatch[]): Map<string, string> {
  const perFile = new Map<string, string[]>();
  const fileCount = new Map<string, number>();
  for (const p of patches) {
    const r = renamesInFile(p);
    if (!r) continue;
    perFile.set(p.path, r);
    for (const pair of r) fileCount.set(pair, (fileCount.get(pair) ?? 0) + 1);
  }

  const out = new Map<string, string>();
  for (const [path, pairs] of perFile) {
    if (pairs.every((pair) => (fileCount.get(pair) ?? 0) >= MIN_REFACTOR_FILES)) out.set(path, pairs.join(', '));
  }
  return out;
}
