import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DEFAULT_FILTERS, type FilterState } from '../core/filters';

/** What a worktree window needs to know to resume its review. */
export interface WorktreeEntry {
  baseUrl: string;
  projectId: number;
  projectPath: string;
  iid: number;
  gitDir: string;
  worktree: string;
}

export interface MrState {
  /** path → blob sha that was viewed. A new push changes the sha, which makes the file unviewed again. */
  viewed: Record<string, string>;
  filters: FilterState;
  lastOpened?: string;
  /** The MR version (head commit) the user last submitted a review or approved on. */
  reviewed?: { headSha: string; at: string };
  /** A version picked with "Compare With Version…" (overrides `reviewed` as the comparison base). */
  compareWith?: { headSha: string; label: string };
}

const WORKTREES_KEY = 'ripple.worktrees';
const ACTIVE_KEY = 'ripple.active';

export class Store {
  constructor(private readonly context: vscode.ExtensionContext) {}

  worktrees(): Record<string, WorktreeEntry> {
    return this.context.globalState.get<Record<string, WorktreeEntry>>(WORKTREES_KEY, {});
  }

  async registerWorktree(e: WorktreeEntry) {
    await this.context.globalState.update(WORKTREES_KEY, { ...this.worktrees(), [e.worktree]: e });
  }

  async unregisterWorktree(worktree: string) {
    const all = { ...this.worktrees() };
    delete all[worktree];
    await this.context.globalState.update(WORKTREES_KEY, all);
  }

  /** The MR being reviewed in this window (restored on reload). */
  activeReview(): WorktreeEntry | undefined {
    return this.context.workspaceState.get<WorktreeEntry>(ACTIVE_KEY);
  }

  async setActiveReview(e: WorktreeEntry | undefined) {
    await this.context.workspaceState.update(ACTIVE_KEY, e);
  }

  async loadMrState(e: WorktreeEntry): Promise<MrState> {
    try {
      const raw = JSON.parse(await readFile(this.mrStateFile(e), 'utf8')) as Partial<MrState>;
      return { viewed: raw.viewed ?? {}, filters: { ...DEFAULT_FILTERS, ...raw.filters }, lastOpened: raw.lastOpened, reviewed: raw.reviewed, compareWith: raw.compareWith };
    } catch {
      return { viewed: {}, filters: { ...DEFAULT_FILTERS } };
    }
  }

  async saveMrState(e: WorktreeEntry, s: MrState) {
    const file = this.mrStateFile(e);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(s, null, 2));
  }

  private mrStateFile(e: WorktreeEntry): string {
    return path.join(this.context.globalStorageUri.fsPath, 'mr', `${e.projectId}-${e.iid}`, 'state.json');
  }
}
