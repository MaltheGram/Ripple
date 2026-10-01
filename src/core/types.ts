export type ChangeType = 'added' | 'modified' | 'deleted' | 'renamed';

export type TrivialReason =
  | 'generated'
  | 'rename-only'
  | 'mode-only'
  | 'whitespace-only'
  | 'import-only'
  | 'moved-code'
  | 'refactor';

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Raw hunk body lines, each prefixed with '+', '-' or '\\'. */
  lines: string[];
}

export interface FilePatch {
  path: string;
  oldPath: string;
  change: ChangeType;
  binary: boolean;
  modeChanged: boolean;
  oldBlob?: string;
  newBlob?: string;
  hunks: Hunk[];
  additions: number;
  deletions: number;
}

export interface ChangedFile extends FilePatch {
  trivial?: TrivialReason;
  isTest: boolean;
  /** Lower = review earlier. See `roleRank`. */
  role: number;
  /** Set when `trivial === 'refactor'`: the identifier renames, e.g. "fooBar → fooBaz". */
  refactor?: string;
}

export interface MrRef {
  baseUrl: string;
  projectPath: string;
  iid: number;
}
