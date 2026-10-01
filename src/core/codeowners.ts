import { minimatch } from 'minimatch';

// GitLab CODEOWNERS: sections ([Name], ^[Optional], [Name][2]), patterns in gitignore style, owners as @user,
// @group/subgroup or email. Within a section the last matching pattern wins; a file gets owners from every section.

export interface OwnerRule {
  section: string;
  optional: boolean;
  pattern: string;
  owners: string[];
}

export const CODEOWNERS_PATHS = ['.gitlab/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

export function parseCodeowners(text: string): OwnerRule[] {
  const rules: OwnerRule[] = [];
  let section = '';
  let optional = false;
  let sectionOwners: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const sec = /^(\^)?\[([^\]]+)\](?:\[\d+\])?\s*(.*)$/.exec(line);
    if (sec) {
      optional = !!sec[1];
      section = sec[2];
      sectionOwners = sec[3].split(/\s+/).filter(Boolean);
      continue;
    }
    const [pattern, ...owners] = line.split(/\s+/);
    rules.push({ section, optional, pattern, owners: owners.length ? owners : sectionOwners });
  }
  return rules;
}

/** Owners of a file (deduplicated, across sections). */
export function ownersOf(path: string, rules: OwnerRule[]): string[] {
  const lastPerSection = new Map<string, OwnerRule>();
  for (const r of rules) if (matches(r.pattern, path)) lastPerSection.set(r.section, r);
  return [...new Set([...lastPerSection.values()].flatMap((r) => r.owners))];
}

/** gitignore-style match: `/x` anchored, `dir/` = contents, no slash = anywhere, `*` within a segment. */
export function matches(pattern: string, path: string): boolean {
  let p = pattern;
  if (p === '*') return true;
  const anchored = p.startsWith('/') || p.slice(0, -1).includes('/');
  p = p.replace(/^\//, '');
  const dir = p.endsWith('/');
  if (dir) p = p.slice(0, -1);
  const base = anchored ? p : `**/${p}`;
  const opts = { dot: true };
  return minimatch(path, base, opts) || minimatch(path, `${base}/**`, opts);
}

/** Is the user one of the owners (by @username or a group they belong to)? */
export function isOwner(owners: string[], username: string, groups: string[]): boolean {
  const mine = new Set([`@${username}`.toLowerCase(), ...groups.map((g) => `@${g}`.toLowerCase())]);
  return owners.some((o) => mine.has(o.toLowerCase()));
}
