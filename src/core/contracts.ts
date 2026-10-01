import type { ChangedFile, Hunk } from './types';

// Pure detection of "contracts" an MR changes: shared types/DTOs/events, HTTP routes and event names.
// Heuristic by design: it decides what is worth searching for in other repositories.

export type ContractKind = 'type' | 'route' | 'event';
export type ChangeImpact = 'added' | 'additive' | 'breaking' | 'modified' | 'removed';

export interface Contract {
  kind: ContractKind;
  /** Type name, "GET /orders/:id" or event name. */
  name: string;
  /** What to search for in other repositories. */
  query: string;
  /** Optional stricter match for search results (routes). */
  matcher?: RegExp;
  impact: ChangeImpact;
  /** Human detail, e.g. "removed: status; added: state?". */
  detail: string;
  path: string;
  /** 1-based line of the declaration, on `side`. */
  line: number;
  side: 'new' | 'old';
}

const DECL = /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(class|interface|enum|type|const)\s+([A-Za-z_$][\w$]*)/;
const CONTRACT_NAME = /(Dto|DTO|Event|Payload|Message|Command|Query|Request|Response|Contract|Schema|Model|Entity|Enum|Type|Status|Props)$/;
const CONTRACT_PATH = /(^|\/)(dto|dtos|contracts?|events?|messages?|schemas?|types|interfaces|models?|entities|shared|common|libs?|packages)\//i;
const MEMBER = /^\s*(?:readonly\s+|public\s+|private\s+|protected\s+|static\s+)*([A-Za-z_$][\w$]*)(\?)?\s*(?::|=|\(|,|$)/;
const HTTP = /@(Get|Post|Put|Patch|Delete|All|Head|Options)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/;
const EXPRESS = /\b(?:router|app|server)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/i;
const CONTROLLER = /@Controller\(\s*(?:\{[^}]*path:\s*)?['"`]([^'"`]*)['"`]/;
const EVENT = [
  /@(?:EventPattern|MessagePattern|OnEvent|SqsMessageHandler|Subscribe)\(\s*['"`]([\w.:\-/]+)['"`]/,
  /\.(?:emit|publish|dispatch|send|sendMessage)\(\s*['"`]([\w.:\-/]{3,})['"`]/,
];

/** Contracts changed by the MR. `newText(path)` returns the new file's lines (undefined for deleted files). */
export function detectContracts(files: ChangedFile[], newText: (path: string) => string[] | undefined): Contract[] {
  const out: Contract[] = [];
  for (const f of files) {
    if (f.binary || f.isTest || (f.trivial && f.trivial !== 'refactor')) continue;
    if (f.change === 'deleted') {
      out.push(...removedDeclarations(f));
      continue;
    }
    const lines = newText(f.path);
    if (!lines) continue;
    out.push(...changedDeclarations(f, lines), ...routes(f, lines), ...events(f));
  }
  return dedupe(out);
}

function isContractish(path: string, name: string, role: number): boolean {
  return role === 1 || CONTRACT_NAME.test(name) || CONTRACT_PATH.test(path);
}

/** Exported declarations whose body overlaps the MR's changes, with an impact from the member diff. */
function changedDeclarations(f: ChangedFile, lines: string[]): Contract[] {
  const out: Contract[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = DECL.exec(lines[i]);
    if (!m) continue;
    const [, keyword, name] = m;
    if (keyword === 'const' && !/[A-Z]/.test(name[0])) continue;
    if (!isContractish(f.path, name, f.role)) continue;
    const start = i + 1;
    const end = blockEnd(lines, i) + 1;
    const hunks = f.hunks.filter((h) => overlapsNew(h, start, end));
    if (!hunks.length) continue;
    const impact = f.change === 'added' ? { impact: 'added' as const, detail: 'new in this MR' } : memberImpact(hunks);
    out.push({ kind: 'type', name, query: name, ...impact, path: f.path, line: start, side: 'new' });
  }
  return out;
}

function removedDeclarations(f: ChangedFile): Contract[] {
  const out: Contract[] = [];
  for (const h of f.hunks) {
    let old = h.oldStart;
    for (const raw of h.lines) {
      if (raw[0] !== '-') continue;
      const m = DECL.exec(raw.slice(1));
      if (m && isContractish(f.oldPath, m[2], f.role)) {
        out.push({ kind: 'type', name: m[2], query: m[2], impact: 'removed', detail: 'file deleted', path: f.oldPath, line: old, side: 'old' });
      }
      old++;
    }
  }
  return out;
}

/** Compare member names in removed vs added lines: removed names mean a breaking change for consumers. */
export function memberImpact(hunks: Hunk[]): { impact: ChangeImpact; detail: string } {
  const members = (sign: '+' | '-') =>
    hunks
      .flatMap((h) => h.lines.filter((l) => l[0] === sign).map((l) => l.slice(1)))
      .filter((l) => !/^\s*(\/\/|\*|\/\*|@|}|{|$)/.test(l))
      .map((l) => MEMBER.exec(l))
      .filter((m): m is RegExpExecArray => !!m && !['export', 'import', 'return', 'const', 'let', 'if', 'for'].includes(m[1]))
      .map((m) => ({ name: m[1], optional: !!m[2] }));
  const removed = members('-');
  const added = members('+');
  const addedNames = new Set(added.map((a) => a.name));
  const removedNames = new Set(removed.map((r) => r.name));
  const gone = [...removedNames].filter((n) => !addedNames.has(n));
  const fresh = added.filter((a) => !removedNames.has(a.name));
  const changed = [...removedNames].filter((n) => addedNames.has(n));
  const parts = [
    gone.length ? `removed: ${gone.join(', ')}` : '',
    changed.length ? `changed: ${changed.join(', ')}` : '',
    fresh.length ? `added: ${fresh.map((a) => a.name + (a.optional ? '?' : '')).join(', ')}` : '',
  ].filter(Boolean);
  const impact: ChangeImpact = gone.length ? 'breaking' : changed.length ? 'modified' : fresh.length ? 'additive' : 'modified';
  return { impact, detail: parts.join('; ') || 'body changed' };
}

function routes(f: ChangedFile, lines: string[]): Contract[] {
  const prefix = lines.map((l) => CONTROLLER.exec(l)?.[1]).find((p) => p !== undefined) ?? '';
  const found = new Map<string, { added: boolean; removed: boolean; line: number }>();
  forChanged(f, (sign, text, line) => {
    const nest = HTTP.exec(text);
    const exp = nest ? undefined : EXPRESS.exec(text);
    if (!nest && !exp) return;
    const method = (nest?.[1] ?? exp![1]).toUpperCase();
    const route = normalizeRoute(nest ? `${prefix}/${nest[2] ?? ''}` : exp![2]);
    const key = `${method} ${route}`;
    const cur = found.get(key) ?? { added: false, removed: false, line };
    if (sign === '+') cur.added = true;
    else cur.removed = true;
    found.set(key, cur);
  });
  return [...found].map(([key, v]) => {
    const route = key.slice(key.indexOf(' ') + 1);
    const impact: ChangeImpact = v.added && v.removed ? 'modified' : v.removed ? 'breaking' : 'added';
    return {
      kind: 'route' as const,
      name: key,
      ...routeQuery(route),
      impact,
      detail: impact === 'breaking' ? 'route removed or renamed' : impact === 'added' ? 'new route' : 'route changed',
      path: f.path,
      line: v.line,
      side: 'new' as const,
    };
  });
}

function events(f: ChangedFile): Contract[] {
  const found = new Map<string, { added: boolean; removed: boolean; line: number }>();
  forChanged(f, (sign, text, line) => {
    for (const re of EVENT) {
      const m = re.exec(text);
      if (!m) continue;
      const cur = found.get(m[1]) ?? { added: false, removed: false, line };
      if (sign === '+') cur.added = true;
      else cur.removed = true;
      found.set(m[1], cur);
    }
  });
  return [...found].map(([name, v]) => ({
    kind: 'event' as const,
    name,
    query: name,
    impact: (v.added && v.removed ? 'modified' : v.removed ? 'breaking' : 'added') as ChangeImpact,
    detail: v.removed && !v.added ? 'no longer emitted/handled here' : v.added && !v.removed ? 'newly emitted/handled here' : 'usage changed',
    path: f.path,
    line: v.line,
    side: 'new' as const,
  }));
}

/** Search for the longest static segment; match results against the full route with params as wildcards. */
export function routeQuery(route: string): { query: string; matcher: RegExp } {
  const segments = route.split('/').filter(Boolean);
  const statics = segments.filter((s) => !s.startsWith(':') && !s.includes('*'));
  const query = statics.sort((a, b) => b.length - a.length)[0] ?? route;
  const pattern = segments
    .map((s) => (s.startsWith(':') || s.includes('*') ? String.raw`(?:\$\{[^}]+\}|[^/'"\x60\s?]+)` : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return { query, matcher: new RegExp(`/${pattern}(?:['"\\x60/?]|$)`) };
}

function normalizeRoute(r: string): string {
  return '/' + r.split('/').filter(Boolean).join('/');
}

function forChanged(f: ChangedFile, fn: (sign: '+' | '-', text: string, newLine: number) => void) {
  for (const h of f.hunks) {
    let n = h.newStart;
    for (const raw of h.lines) {
      if (raw[0] === '+') fn('+', raw.slice(1), n++);
      else if (raw[0] === '-') fn('-', raw.slice(1), Math.max(1, h.newLines > 0 ? h.newStart : h.newStart + 1));
    }
  }
}

/** End (0-based) of the block starting at `start`, by brace depth; single-line declarations end where they start. */
function blockEnd(lines: string[], start: number): number {
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i].replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '')) {
      if (ch === '{') {
        depth++;
        opened = true;
      } else if (ch === '}') depth--;
    }
    if (opened && depth <= 0) return i;
    if (!opened && /;\s*$/.test(lines[i])) return i;
  }
  return start;
}

function overlapsNew(h: Hunk, start: number, end: number): boolean {
  const s = h.newLines > 0 ? h.newStart : h.newStart + 1;
  const e = h.newLines > 0 ? h.newStart + h.newLines - 1 : h.newStart + 1;
  return e >= start && s <= end;
}

const IMPACT_RANK: Record<ChangeImpact, number> = { breaking: 0, removed: 0, modified: 1, additive: 2, added: 3 };

function dedupe(cs: Contract[]): Contract[] {
  const seen = new Map<string, Contract>();
  for (const c of cs) {
    const key = `${c.kind}:${c.name}`;
    const prev = seen.get(key);
    if (!prev || IMPACT_RANK[c.impact] < IMPACT_RANK[prev.impact]) seen.set(key, c);
  }
  return [...seen.values()].sort((a, b) => IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact] || a.name.localeCompare(b.name));
}
