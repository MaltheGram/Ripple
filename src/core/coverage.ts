import type { Hunk } from './types';

/** line → hit count, for instrumented lines only. */
export type LineHits = Map<number, number>;

/** Parse lcov (`SF:` / `DA:line,hits` / `end_of_record`). Keys are the source paths as written in the report. */
export function parseLcov(text: string): Map<string, LineHits> {
  const out = new Map<string, LineHits>();
  let cur: LineHits | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      cur = new Map();
      out.set(line.slice(3), cur);
    } else if (line.startsWith('DA:') && cur) {
      const [ln, hits] = line.slice(3).split(',');
      cur.set(Number(ln), Number(hits));
    } else if (line === 'end_of_record') cur = undefined;
  }
  return out;
}

/**
 * Map report paths to repository paths. Reports contain absolute CI paths (`/builds/group/repo/apps/x/src/a.ts`)
 * or paths relative to the project (`src/a.ts`); `projectDir` is the project folder the report belongs to.
 */
export function resolveCoveragePaths(report: Map<string, LineHits>, repoPaths: string[], projectDir: string): Map<string, LineHits> {
  const out = new Map<string, LineHits>();
  for (const [sf, hits] of report) {
    const norm = sf.replace(/\\/g, '/');
    const rel = norm.startsWith('/') ? repoPaths.find((p) => norm.endsWith(`/${p}`)) : [`${projectDir}/${norm}`, norm].find((p) => repoPaths.includes(p));
    if (rel) out.set(rel, hits);
  }
  return out;
}

export interface ChangedCoverage {
  /** Changed (added) lines that are instrumented. */
  measured: number;
  covered: number;
  /** 1-based new-file lines that changed and have 0 hits. */
  uncovered: number[];
}

/** Coverage of the lines an MR added or changed in one file. Lines without instrumentation (types, comments) are skipped. */
export function changedLineCoverage(hunks: Hunk[], hits: LineHits): ChangedCoverage {
  const uncovered: number[] = [];
  let measured = 0;
  let covered = 0;
  for (const h of hunks) {
    for (let l = h.newStart; l < h.newStart + h.newLines; l++) {
      const n = hits.get(l);
      if (n === undefined) continue;
      measured++;
      if (n > 0) covered++;
      else uncovered.push(l);
    }
  }
  return { measured, covered, uncovered };
}
