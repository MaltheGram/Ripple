import { minimatch } from 'minimatch';
import { detectRefactors } from './refactor';
import type { ChangedFile, FilePatch, TrivialReason } from './types';

// Conservative on purpose: a false "trivial" hides real changes from the reviewer.
const IMPORT_LINE = [
  /^\s*import\s.+\sfrom\s+['"][^'"]+['"];?\s*$/, // import { a } from 'x';
  /^\s*import\s+['"][^'"]+['"];?\s*$/, // import 'x';
  /^\s*export\s+(\*|\{[^}]*\})\s+from\s+['"][^'"]+['"];?\s*$/, // export { a } from 'x';
  /^\s*(const|let|var)\s+[\w{}\s,]+=\s*require\(['"][^'"]+['"]\);?\s*$/, // const a = require('x');
  /^\s*from\s+[\w.]+\s+import\s+[\w\s,*]+$/, // from a import b
  /^\s*import\s+[\w.]+(\s+as\s+\w+)?\s*$/, // import a.b (python)
];
const isImportLine = (text: string) => IMPORT_LINE.some((re) => re.test(text));
const MIN_MOVED_LINES = 3;
const MIN_MOVED_LINE_LENGTH = 8;

export interface ClassifyInput {
  patches: FilePatch[];
  /** path → changed lines when diffed with `-w`. Missing entry = no non-whitespace change. */
  whitespaceIgnored: Map<string, number>;
  trivialGlobs: string[];
}

export function classify({ patches, whitespaceIgnored, trivialGlobs }: ClassifyInput): ChangedFile[] {
  const moved = movedLineIndex(patches);
  const refactors = detectRefactors(patches);
  return patches.map((p) => {
    const trivial = trivialReason(p, whitespaceIgnored, trivialGlobs, moved);
    const refactor = trivial ? undefined : refactors.get(p.path);
    return {
      ...p,
      trivial: trivial ?? (refactor ? 'refactor' : undefined),
      refactor,
      isTest: isTestPath(p.path),
      role: roleRank(p.path),
    };
  });
}

function trivialReason(
  p: FilePatch,
  ws: Map<string, number>,
  globs: string[],
  moved: MovedIndex,
): TrivialReason | undefined {
  if (globs.some((g) => minimatch(p.path, g, { dot: true }))) return 'generated';
  if (p.binary) return undefined;

  const changed = p.additions + p.deletions;
  if (changed === 0) {
    if (p.change === 'renamed') return 'rename-only';
    if (p.modeChanged) return 'mode-only';
    return undefined;
  }
  if (p.change === 'added' || p.change === 'deleted') return undefined;

  if ((ws.get(p.path) ?? 0) === 0) return 'whitespace-only';

  const bodies = changedLines(p).filter((l) => l.text.trim() !== '');
  if (bodies.length > 0 && bodies.every((l) => isImportLine(l.text))) return 'import-only';

  // Short lines like `}` or `return;` match everywhere, so only meaningful lines count as evidence.
  const meaningful = bodies.filter((l) => l.text.trim().length >= MIN_MOVED_LINE_LENGTH);
  if (meaningful.length >= MIN_MOVED_LINES && meaningful.every((l) => moved.has(l))) return 'moved-code';
  return undefined;
}

interface ChangedLine {
  sign: '+' | '-';
  text: string;
  path: string;
}

function changedLines(p: FilePatch): ChangedLine[] {
  const out: ChangedLine[] = [];
  for (const h of p.hunks) {
    for (const raw of h.lines) {
      const sign = raw[0];
      if (sign === '+' || sign === '-') out.push({ sign, text: raw.slice(1), path: p.path });
    }
  }
  return out;
}

interface MovedIndex {
  has(line: ChangedLine): boolean;
}

/**
 * A changed line counts as "moved" when the same (trimmed) text appears with the opposite sign
 * in a *different* file of the MR. Used to spot code that was cut from one file and pasted into another.
 */
function movedLineIndex(patches: FilePatch[]): MovedIndex {
  const added = new Map<string, Set<string>>();
  const removed = new Map<string, Set<string>>();
  for (const p of patches) {
    for (const l of changedLines(p)) {
      const key = l.text.trim();
      if (!key) continue;
      const bucket = l.sign === '+' ? added : removed;
      if (!bucket.has(key)) bucket.set(key, new Set());
      bucket.get(key)!.add(l.path);
    }
  }
  return {
    has(l) {
      const other = (l.sign === '+' ? removed : added).get(l.text.trim());
      if (!other) return false;
      for (const path of other) if (path !== l.path) return true;
      return false;
    },
  };
}

const TEST_RE = /(^|\/)(__tests__|tests?|spec|e2e)\/|[._-](test|spec|e2e)\.[^/]+$|_test\.go$/i;

export function isTestPath(path: string): boolean {
  return TEST_RE.test(path);
}

const ROLES: [RegExp, number][] = [
  [/(^|\/)migrations?\//i, 0],
  [/(dto|entity|entities|model|models|types?|interfaces?|schema|contracts?|enums?)(\/|\.[^/]+$)/i, 1],
  [/repositor(y|ies)(\/|\.[^/]+$)/i, 2],
  [/services?(\/|\.[^/]+$)/i, 3],
  [/(controller|resolver|handler|consumer|listener|gateway|router|routes?)s?(\/|\.[^/]+$)/i, 4],
  [/(module|config|main)\.[^/]+$/i, 5],
];

/**
 * Suggested review order: contracts first, then the code that uses them, tests last.
 * 0 migrations · 1 types/DTOs/entities · 2 repositories · 3 services · 4 controllers/consumers ·
 * 5 wiring/config · 6 other · 7 tests
 */
export function roleRank(path: string): number {
  if (isTestPath(path)) return 7;
  for (const [re, rank] of ROLES) if (re.test(path)) return rank;
  return 6;
}
