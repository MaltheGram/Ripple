import { minimatch } from 'minimatch';
import type { ChangeType, ChangedFile } from './types';

export type SortMode = 'path' | 'size' | 'suggested';
export type ViewedFilter = 'all' | 'viewed' | 'unviewed';
export type KindFilter = 'all' | 'src' | 'test';
export type GroupBy = 'folder' | 'ai';

export interface FilterState {
  changeTypes: ChangeType[];
  pathGlob?: string;
  hideTrivial: boolean;
  viewed: ViewedFilter;
  kind: KindFilter;
  focusGroup?: string;
  sort: SortMode;
  /** Folder groups, or AI review units when an AI analysis exists. */
  groupBy?: GroupBy;
  /** Only files the current user owns per CODEOWNERS. */
  onlyMine?: boolean;
  /** Only files changed since the version the user last reviewed. */
  sinceReview?: boolean;
}

export const DEFAULT_FILTERS: FilterState = {
  changeTypes: ['added', 'modified', 'deleted', 'renamed'],
  hideTrivial: true,
  viewed: 'all',
  kind: 'all',
  sort: 'suggested',
};

export function applyFilters(
  files: ChangedFile[],
  f: FilterState,
  isViewed: (file: ChangedFile) => boolean,
  groupOf: (file: ChangedFile) => string = (file) => groupKey(file.path),
): ChangedFile[] {
  return files.filter((file) => {
    if (!f.changeTypes.includes(file.change)) return false;
    if (f.hideTrivial && file.trivial) return false;
    if (f.viewed === 'viewed' && !isViewed(file)) return false;
    if (f.viewed === 'unviewed' && isViewed(file)) return false;
    if (f.kind === 'src' && file.isTest) return false;
    if (f.kind === 'test' && !file.isTest) return false;
    if (f.focusGroup !== undefined && groupOf(file) !== f.focusGroup) return false;
    if (f.pathGlob && !matchesGlob(file, f.pathGlob)) return false;
    return true;
  });
}

function matchesGlob(file: ChangedFile, glob: string): boolean {
  const pattern = glob.includes('*') || glob.includes('/') ? glob : `**/*${glob}*`;
  return minimatch(file.path, pattern, { dot: true, nocase: true }) || minimatch(file.oldPath, pattern, { dot: true, nocase: true });
}

export function sortFiles(files: ChangedFile[], mode: SortMode): ChangedFile[] {
  const byPath = (a: ChangedFile, b: ChangedFile) => a.path.localeCompare(b.path);
  const sorted = [...files];
  if (mode === 'path') sorted.sort(byPath);
  if (mode === 'size') sorted.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions) || byPath(a, b));
  if (mode === 'suggested') sorted.sort((a, b) => a.role - b.role || byPath(a, b));
  return sorted;
}

/** Folders that belong to their parent feature folder rather than being a review unit of their own. */
const LEAF_DIRS = new Set([
  'dto', 'dtos', 'entities', 'entity', 'interfaces', 'types', 'enums', 'models', 'schemas',
  'test', 'tests', '__tests__', '__mocks__', 'spec', 'fixtures', 'utils', 'helpers', 'components', 'hooks',
]);

/** Folder-based review unit, e.g. `apps/api/src/order` for `apps/api/src/order/dto/create.dto.ts`. */
export function groupKey(path: string): string {
  const dirs = path.split('/').slice(0, -1);
  while (dirs.length > 1 && LEAF_DIRS.has(dirs[dirs.length - 1].toLowerCase())) dirs.pop();
  return dirs.length === 0 ? '(root)' : dirs.join('/');
}

export interface FileGroup {
  key: string;
  files: ChangedFile[];
}

/**
 * Group files. Groups keep the order their first file appears in `files`, unless `order` lists keys
 * (e.g. AI review order), in which case listed groups come first in that order.
 */
export function groupFiles(
  files: ChangedFile[],
  keyOf: (f: ChangedFile) => string = (f) => groupKey(f.path),
  order?: string[],
): FileGroup[] {
  const map = new Map<string, ChangedFile[]>();
  for (const f of files) {
    const k = keyOf(f);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(f);
  }
  const groups = [...map].map(([key, files]) => ({ key, files }));
  if (!order) return groups;
  const rank = (k: string) => {
    const i = order.indexOf(k);
    return i === -1 ? order.length : i;
  };
  return groups.sort((a, b) => rank(a.key) - rank(b.key));
}
