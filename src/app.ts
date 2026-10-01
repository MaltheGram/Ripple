import * as vscode from 'vscode';
import { getGitLabToken, GitLabAuthProvider } from './auth/gitlabAuth';
import { routeIndexFor } from './analysis/trace';
import { GitLabClient, GitLabError } from './gitlab/client';
import type { GlMergeRequest } from './gitlab/types';
import { log, timed } from './log';
import { Store, type WorktreeEntry } from './state/store';
import { CommentsController } from './ui/comments';
import { CommentsView } from './ui/commentsView';
import { CoverageDecorations } from './ui/coverageDecorations';
import { CrossServiceView } from './ui/crossServiceView';
import { ExplainView } from './ui/explainView';
import { ImpactView } from './ui/impactView';
import { MrListTree } from './ui/mrList';
import { OverviewProvider } from './ui/overview';
import { ReviewSession } from './ui/session';
import { TraceLens } from './ui/traceLens';
import { ReviewTree } from './ui/tree';

/**
 * Shared state for the command modules: the views, the store and the review session of this window.
 * `commands/*` register their commands against it; `extension.ts` only wires things up.
 */
export class App {
  readonly auth: GitLabAuthProvider;
  readonly store: Store;
  readonly tree = new ReviewTree();
  readonly comments = new CommentsController();
  readonly impact = new ImpactView();
  readonly commentsView = new CommentsView();
  readonly explainView: ExplainView;
  readonly crossService = new CrossServiceView();
  readonly traceLens = new TraceLens(() => this.session);
  readonly overview = new OverviewProvider();
  readonly coverage = new CoverageDecorations();
  readonly mrList: MrListTree;
  private current?: ReviewSession;
  private readonly sessionListeners: ((s: ReviewSession | undefined) => void)[] = [];

  constructor(readonly context: vscode.ExtensionContext) {
    this.auth = new GitLabAuthProvider(context);
    this.store = new Store(context);
    this.explainView = new ExplainView(context);
    this.mrList = new MrListTree(
      () => this.client(),
      () => getGitLabToken(false).then(() => true, () => false),
    );
    context.subscriptions.push(
      this.auth,
      this.tree,
      this.comments,
      this.impact,
      this.commentsView,
      this.explainView,
      this.crossService,
      this.traceLens,
      this.overview,
      this.coverage,
      this.mrList,
      { dispose: () => this.setSession(undefined) },
    );
  }

  get session(): ReviewSession | undefined {
    return this.current;
  }

  /** The open review, or a helpful error. */
  need(): ReviewSession {
    if (!this.current) throw new Error('No merge request is open in this window. Pick one in the Merge Requests view.');
    return this.current;
  }

  onSessionChange(fn: (s: ReviewSession | undefined) => void) {
    this.sessionListeners.push(fn);
  }

  setSession(s: ReviewSession | undefined) {
    this.current?.dispose();
    this.current = s;
    this.tree.setSession(s);
    this.comments.setSession(s);
    this.impact.setSession(s);
    this.commentsView.setSession(s);
    this.explainView.setSession(s);
    this.crossService.setSession(s);
    this.traceLens.refresh();
    this.overview.setSession(s);
    this.coverage.setSession(s);
    this.mrList.setActive(s && { projectId: s.entry.projectId, iid: s.entry.iid });
    this.sessionListeners.forEach((fn) => fn(s));
    void vscode.commands.executeCommand('setContext', 'ripple.active', !!s);
  }

  /** Load a checked-out MR into this window. */
  async start(entry: WorktreeEntry, mr?: GlMergeRequest, report?: (m: string) => void) {
    report?.('Computing diff…');
    const s = await timed(`open review !${entry.iid}`, async () =>
      vscode.window.withProgress({ location: { viewId: 'ripple.files' } }, () => ReviewSession.open(entry, this.client(entry.baseUrl), this.store, mr)),
    );
    this.setSession(s);
    await this.store.setActiveReview(entry);
    void vscode.commands.executeCommand('ripple.files.focus');
    // Warm up the route index so the first trace is instant.
    void routeIndexFor(s).catch((e) => log().warn(`route index: ${e instanceof Error ? e.message : e}`));
  }

  client(baseUrl = configuredBaseUrl()): GitLabClient {
    return new GitLabClient(baseUrl, () => getGitLabToken(false));
  }

  /** Register a command whose errors become friendly notifications. */
  command(id: string, fn: (...args: any[]) => unknown) {
    this.context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          return await fn(...args);
        } catch (e) {
          if (e instanceof vscode.CancellationError) return;
          await showError(e);
        }
      }),
    );
  }

  push(...d: vscode.Disposable[]) {
    this.context.subscriptions.push(...d);
  }
}

export function configuredBaseUrl(): string {
  return vscode.workspace.getConfiguration('ripple.gitlab').get<string>('baseUrl', 'https://gitlab.com').replace(/\/+$/, '');
}

/** Turn errors into messages a reviewer can act on (sign in again, retry later, …). */
export async function showError(e: unknown) {
  const raw = e instanceof Error ? e.message : String(e);
  log().error(raw);
  if (e instanceof GitLabError) {
    if (e.status === 401) {
      const a = await vscode.window.showErrorMessage('Your GitLab sign-in has expired or was revoked.', 'Sign in');
      if (a) await vscode.commands.executeCommand('ripple.signIn');
      return;
    }
    if (e.status === 403) return void vscode.window.showErrorMessage(`GitLab refused this action: you may not have permission. (${raw})`);
    if (e.status === 404) return void vscode.window.showErrorMessage(`GitLab couldn't find it (deleted, moved, or no access). (${raw})`);
    if (e.status === 429) return void vscode.window.showWarningMessage(`GitLab is rate-limiting requests. Try again in ${e.retryAfter ? `${e.retryAfter} s` : 'a minute'}.`);
    if (e.status >= 500) return void vscode.window.showErrorMessage(`GitLab is having trouble (${e.status}). Try again shortly.`);
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network/i.test(raw)) {
    return void vscode.window.showErrorMessage("Can't reach GitLab. Check your network or VPN and try again.");
  }
  if (/Not signed in to GitLab/.test(raw)) {
    const a = await vscode.window.showErrorMessage(raw, 'Sign in');
    if (a) await vscode.commands.executeCommand('ripple.signIn');
    return;
  }
  void vscode.window.showErrorMessage(raw);
}
