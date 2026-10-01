import * as vscode from 'vscode';
import { getGitLabToken } from '../auth/gitlabAuth';
import { classify } from '../core/classify';
import type { AiAnalysis, AiRisk } from '../ai/analysis';
import { loadReviewMeta, type ReviewMeta } from '../analysis/reviewMeta';
import { applyFilters, groupKey, sortFiles, type FilterState } from '../core/filters';
import { parseNumstatZ, parsePatch } from '../core/patch';
import type { ChangedFile } from '../core/types';
import type { GitLabClient } from '../gitlab/client';
import type { GlDiscussion, GlDraftNote, GlMergeRequest, GlUser } from '../gitlab/types';
import { log, timed } from '../log';
import { git } from '../repo/git';
import { fetchMr, moveWorktree } from '../repo/repoManager';
import type { MrState, Store, WorktreeEntry } from '../state/store';

/** One MR under review in this window. */
export class ReviewSession implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  /** Files, filters or viewed state changed. */
  readonly onDidChange = this.changed.event;
  private readonly commentsChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeComments = this.commentsChanged.event;

  files: ChangedFile[] = [];
  discussions: GlDiscussion[] = [];
  drafts: GlDraftNote[] = [];
  me?: GlUser;
  /** AI analysis for the current MR version (memory only). */
  ai?: AiAnalysis;
  /**
   * "Since your review": the version compared against (reviewed or picked) and the MR files that changed since.
   * Undefined when there is nothing to compare (never reviewed, or no new commits).
   */
  since?: { base: string; label: string; files: Set<string> };
  /** Files changed since a thread's version, per commit (for "code changed since this comment"). */
  private readonly changedSinceCache = new Map<string, Set<string>>();

  /** Approvals, code owners, pipeline and coverage (memory only, loaded in the background). */
  meta: ReviewMeta = {};

  /** Other AI answers (explanations, suggestions) for the current MR version, keyed by feature + target. Memory only. */
  readonly aiCache = new Map<string, unknown>();

  private constructor(
    readonly entry: WorktreeEntry,
    readonly client: GitLabClient,
    private readonly store: Store,
    public mr: GlMergeRequest,
    public state: MrState,
  ) {}

  /** Pass `mr` when the caller just fetched it, to skip another API round trip. */
  static async open(entry: WorktreeEntry, client: GitLabClient, store: Store, mr?: GlMergeRequest): Promise<ReviewSession> {
    const [loaded, state] = await Promise.all([mr ?? client.mergeRequest(entry.projectId, entry.iid), store.loadMrState(entry)]);
    const s = new ReviewSession(entry, client, store, loaded, state);
    await s.refresh({ fetch: false, reloadMr: false, awaitComments: false });
    return s;
  }

  dispose() {
    this.changed.dispose();
    this.commentsChanged.dispose();
  }

  get refs() {
    return this.mr.diff_refs;
  }

  /**
   * Re-read the MR, optionally pull new pushes, recompute the diff and reload comments.
   * Comments load in the background unless `awaitComments`, so the file tree shows first.
   */
  async refresh({
    fetch,
    reloadMr = true,
    awaitComments = true,
    confirmDiscard,
  }: {
    fetch: boolean;
    reloadMr?: boolean;
    awaitComments?: boolean;
    confirmDiscard?: (worktree: string) => Promise<boolean>;
  }) {
    if (reloadMr) this.mr = await timed('api: merge request', () => this.client.mergeRequest(this.entry.projectId, this.entry.iid));
    const token = await getGitLabToken(false);
    const comments = this.reloadComments();

    if (fetch) {
      await timed('git fetch', () => fetchMr(this.entry.gitDir, this.mr, token));
      await moveWorktree(this.entry, this.refs.head_sha, { token, confirmDiscard });
    }
    const { base_sha, head_sha } = this.refs;
    const cwd = this.entry.gitDir;
    // Sequential on purpose: the first diff downloads missing blobs (partial clone), the second reuses them.
    const patch = await timed('git diff', () =>
      git(['diff', '-U0', '-M', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv', base_sha, head_sha], { cwd, token }),
    );
    const ws = await timed('git diff -w', () =>
      git(['diff', '-w', '-M', '--numstat', '-z', '--no-ext-diff', '--no-textconv', base_sha, head_sha], { cwd, token }),
    );
    const trivialGlobs = vscode.workspace.getConfiguration('ripple').get<string[]>('trivialGlobs', []);
    this.files = classify({ patches: parsePatch(patch), whitespaceIgnored: parseNumstatZ(ws), trivialGlobs });
    await this.computeSince(token).catch((e) => log().warn(`since review: ${e instanceof Error ? e.message : e}`));
    if (this.ai && this.ai.headSha !== head_sha) this.ai = undefined;
    if (this.aiCache.get('headSha') !== head_sha) {
      this.aiCache.clear();
      this.aiCache.set('headSha', head_sha);
    }
    this.changed.fire();

    void this.reloadMeta();
    if (awaitComments) await comments;
    else comments.catch((e) => log().error(`Loading comments failed: ${e instanceof Error ? e.message : e}`));
  }

  /** Record the current version as reviewed (on submit / approve). Keeps its commit alive locally via a ref. */
  async markReviewed() {
    const sha = this.refs.head_sha;
    await git(['update-ref', `refs/ripple/mr/${this.entry.iid}/reviewed`, sha], { cwd: this.entry.gitDir }).catch(() => undefined);
    this.state.reviewed = { headSha: sha, at: new Date().toISOString() };
    this.state.compareWith = undefined;
    this.since = undefined;
    await this.persist();
  }

  /** Compare against a chosen MR version instead of the one you reviewed. */
  async compareWith(headSha: string | undefined, label?: string) {
    this.state.compareWith = headSha ? { headSha, label: label ?? headSha.slice(0, 8) } : undefined;
    await this.computeSince(await getGitLabToken(false));
    await this.updateFilters({ sinceReview: !!this.since });
  }

  private async computeSince(token: string) {
    const pick = this.state.compareWith ?? (this.state.reviewed ? { headSha: this.state.reviewed.headSha, label: `your review ${ago(this.state.reviewed.at)}` } : undefined);
    const base = pick?.headSha;
    if (!base || base === this.refs.head_sha) {
      this.since = undefined;
      return;
    }
    await this.ensureCommit(base, token);
    const out = await git(['diff', '--name-only', '-M', base, this.refs.head_sha], { cwd: this.entry.gitDir, token });
    const inMr = new Set(this.files.map((f) => f.path));
    // Only MR files: changes that came in from the target branch (rebases) are not the author's new work.
    this.since = { base, label: pick.label, files: new Set(out.split('\n').filter((p) => inMr.has(p))) };
  }

  /** Make sure a commit is available locally (it may be an old, force-pushed MR version). */
  private async ensureCommit(sha: string, token: string) {
    const have = await git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { cwd: this.entry.gitDir, allowFailure: true, noLazyFetch: true });
    if (!have.trim()) await git(['fetch', '--no-tags', 'origin', sha], { cwd: this.entry.gitDir, token });
  }

  /** Did the thread's file change after the version it was written on? (Sync, from a cache filled with the comments.) */
  changedSinceThread(headSha: string | undefined, path: string | undefined): boolean {
    if (!headSha || !path || headSha === this.refs.head_sha) return false;
    return this.changedSinceCache.get(headSha)?.has(path) ?? false;
  }

  private async fillChangedSince(token: string) {
    const shas = new Set(
      this.discussions
        .filter((d) => d.notes.some((n) => n.resolvable && !n.resolved))
        .map((d) => d.notes[0]?.position?.head_sha)
        .filter((x): x is string => !!x && x !== this.refs.head_sha && !this.changedSinceCache.has(x)),
    );
    for (const sha of [...shas].slice(0, 10)) {
      const out = await git(['diff', '--name-only', sha, this.refs.head_sha], { cwd: this.entry.gitDir, token, allowFailure: true });
      this.changedSinceCache.set(sha, new Set(out.split('\n').filter(Boolean)));
    }
  }

  async reloadMeta() {
    this.meta = await timed('api: review meta', () => loadReviewMeta(this)).catch(() => ({}));
    this.changed.fire();
  }

  async reloadComments() {
    const { projectId, iid } = this.entry;
    [this.discussions, this.drafts, this.me] = await timed('api: comments', () =>
      Promise.all([
        this.client.discussions(projectId, iid),
        this.client.drafts(projectId, iid),
        this.me ?? this.client.currentUser().catch(() => undefined),
      ]),
    );
    await this.fillChangedSince(await getGitLabToken(false)).catch(() => undefined);
    this.commentsChanged.fire();
  }

  /** Files after filters and sorting: the order the tree shows and "next unviewed" walks. */
  visibleFiles(): ChangedFile[] {
    let filtered = applyFilters(this.files, this.state.filters, (f) => this.isViewed(f), (f) => this.groupOf(f));
    if (this.state.filters.sinceReview && this.since) filtered = filtered.filter((f) => this.since!.files.has(f.path));
    if (this.state.filters.onlyMine && this.meta.mine) filtered = filtered.filter((f) => this.meta.mine!.has(f.path));
    const sorted = sortFiles(filtered, this.state.filters.sort);
    const order = this.groupOrder();
    if (!order) return sorted;
    // AI review units: walk groups in the suggested order (stable within a group).
    const rank = (f: ChangedFile) => {
      const i = order.indexOf(this.groupOf(f));
      return i === -1 ? order.length : i;
    };
    return sorted.map((f, i) => ({ f, i })).sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i).map((x) => x.f);
  }

  /** Whether files are grouped by AI review units right now. */
  get aiGrouping(): boolean {
    return this.state.filters.groupBy === 'ai' && !!this.ai;
  }

  groupOf(f: ChangedFile): string {
    if (!this.aiGrouping) return groupKey(f.path);
    return this.ai!.groups.find((g) => g.files.includes(f.path))?.key ?? 'ai:trivial';
  }

  groupOrder(): string[] | undefined {
    return this.aiGrouping ? this.ai!.groups.map((g) => g.key) : undefined;
  }

  groupTitle(key: string): string {
    if (!key.startsWith('ai:')) return key;
    if (key === 'ai:trivial') return 'Trivial files';
    const i = this.ai?.groups.findIndex((g) => g.key === key) ?? -1;
    return i === -1 ? key : `${i + 1}. ${this.ai!.groups[i].title}`;
  }

  risksFor(path: string): AiRisk[] {
    return this.ai?.risks.filter((r) => r.file === path) ?? [];
  }

  setAi(a: AiAnalysis | undefined) {
    this.ai = a;
    this.changed.fire();
  }

  fileByPath(path: string): ChangedFile | undefined {
    return this.files.find((f) => f.path === path || f.oldPath === path);
  }

  isViewed(f: ChangedFile): boolean {
    return this.state.viewed[f.path] === viewKey(f);
  }

  async setViewed(files: ChangedFile[], viewed: boolean) {
    for (const f of files) {
      if (viewed) this.state.viewed[f.path] = viewKey(f);
      else delete this.state.viewed[f.path];
    }
    await this.persist();
  }

  async updateFilters(patch: Partial<FilterState>) {
    this.state.filters = { ...this.state.filters, ...patch };
    await this.persist();
  }

  async setLastOpened(path: string) {
    this.state.lastOpened = path;
    await this.store.saveMrState(this.entry, this.state);
  }

  stats() {
    const trivial = this.files.filter((f) => f.trivial);
    const substantive = this.files.filter((f) => !f.trivial);
    return {
      total: this.files.length,
      trivial: trivial.length,
      substantive: substantive.length,
      substantiveViewed: substantive.filter((f) => this.isViewed(f)).length,
      viewed: this.files.filter((f) => this.isViewed(f)).length,
    };
  }

  private async persist() {
    await this.store.saveMrState(this.entry, this.state);
    this.changed.fire();
  }
}

function ago(iso: string): string {
  const days = Math.round((Date.now() - Date.parse(iso)) / 86_400_000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

function viewKey(f: ChangedFile): string {
  return f.newBlob ?? `deleted:${f.oldBlob ?? ''}`;
}
