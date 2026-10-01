import type { Hunk } from './types';

/** A definition that code in a selection refers to (1-based, inclusive lines in the new file). */
export interface Definition {
  name: string;
  path: string;
  startLine: number;
  endLine: number;
}

export interface ChangedDependency extends Definition {
  /** The MR hunks inside the definition. */
  hunks: Hunk[];
}

/**
 * Keep the definitions the MR changed: those whose range overlaps a changed hunk of their file.
 * Pure deletions count at the line where the deletion happened.
 */
export function changedDependencies(defs: Definition[], hunksByPath: Map<string, Hunk[]>): ChangedDependency[] {
  const out: ChangedDependency[] = [];
  const seen = new Set<string>();
  for (const d of defs) {
    const key = `${d.path}:${d.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hunks = (hunksByPath.get(d.path) ?? []).filter((h) => {
      const start = h.newLines > 0 ? h.newStart : h.newStart + 1;
      const end = h.newLines > 0 ? h.newStart + h.newLines - 1 : h.newStart + 1;
      return end >= d.startLine && start <= d.endLine;
    });
    if (hunks.length) out.push({ ...d, hunks });
  }
  return out;
}

const KEYWORDS = new Set(
  (
    'abstract as async await boolean break case catch class const constructor continue debugger declare default delete do else enum export ' +
    'extends false finally for from function get if implements import in instanceof interface is keyof let module namespace never new null ' +
    'number object of package private protected public readonly require return set static string super switch symbol this throw true try type ' +
    'typeof undefined unique unknown var void while with yield any def self None True False elif lambda pass raise func go defer chan map ' +
    'struct range fn impl pub mut use crate match loop where'
  ).split(' '),
);

/**
 * Unique identifiers in `text` with their first offset, skipping keywords and names too short to matter.
 * Strings and comments are not stripped; go-to-definition on those simply returns nothing.
 */
export function identifiers(text: string, max = 40): { name: string; offset: number }[] {
  const out: { name: string; offset: number }[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const name = m[0];
    if (name.length < 2 || KEYWORDS.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, offset: m.index! });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Fallback when there is no language server (YAML, SQL, old-side virtual documents …): MR hunks whose
 * changed lines mention one of `names` as a whole word. Approximate by nature.
 */
export function textDependencies(
  names: string[],
  files: { path: string; hunks: Hunk[] }[],
  skipPath?: string,
  max = 10,
): ChangedDependency[] {
  const out: ChangedDependency[] = [];
  const words = names.filter((n) => n.length >= 3).map((n) => ({ n, re: new RegExp(`(^|[^\\w$])${n.replace(/\$/g, '\\$')}($|[^\\w$])`) }));
  for (const f of files) {
    if (f.path === skipPath) continue;
    for (const h of f.hunks) {
      const changed = h.lines.filter((l) => l[0] === '+' || l[0] === '-');
      const hit = words.find((w) => changed.some((l) => w.re.test(l.slice(1))));
      if (!hit) continue;
      const start = h.newLines > 0 ? h.newStart : h.newStart + 1;
      out.push({ name: hit.n, path: f.path, startLine: start, endLine: start + Math.max(h.newLines, 1) - 1, hunks: [h] });
      if (out.length >= max) return out;
    }
  }
  return out;
}
