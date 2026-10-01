import * as vscode from 'vscode';
import { getGitLabToken } from '../auth/gitlabAuth';
import { parseMrUrl } from '../core/mrUrl';
import type { GitLabClient } from '../gitlab/client';
import type { GlMergeRequest } from '../gitlab/types';
import { timed } from '../log';
import { checkoutPaths, ensureCheckout, removeWorktree } from '../repo/repoManager';
import type { WorktreeEntry } from '../state/store';
import { GIT_SCHEME } from '../ui/diff';
import type { ReviewSession } from '../ui/session';
import { type App, configuredBaseUrl } from '../app';

/** Opening, switching, closing and cleaning up merge requests. */
export function registerMergeRequestCommands(app: App) {
  app.command('ripple.openMr', () => openMr(app));
  app.command('ripple.reviewMr', async (mr: GlMergeRequest) => {
    const s = app.session;
    if (s?.entry.projectId === mr.project_id && s.entry.iid === mr.iid) {
      await vscode.commands.executeCommand('ripple.files.focus');
      return;
    }
    await checkoutAndStart(app, mr.project_id, mr.iid);
  });
  app.command('ripple.refreshMrs', () => app.mrList.refresh());
  app.command('ripple.openMrItemInGitLab', (node?: { mr?: GlMergeRequest }) => {
    if (node?.mr) return vscode.env.openExternal(vscode.Uri.parse(node.mr.web_url));
  });
  app.command('ripple.closeReview', async () => {
    if (app.session) await closeReviewTabs(app.session);
    app.setSession(undefined);
    await app.store.setActiveReview(undefined);
  });
  app.command('ripple.cleanupWorktrees', () => cleanupWorktrees(app));
}

type MrPick = vscode.QuickPickItem & { mr?: GlMergeRequest; paste?: true };

async function openMr(app: App) {
  await getGitLabToken(true);
  const baseUrl = configuredBaseUrl();
  const client = app.client(baseUrl);

  const picked = await pickMr(client);
  if (!picked) return;

  let projectRef: number | string;
  let iid: number;
  if (picked.paste) {
    const input = await vscode.window.showInputBox({
      title: 'Merge request URL',
      placeHolder: `${baseUrl}/group/project/-/merge_requests/123`,
      ignoreFocusOut: true,
      validateInput: (v) => (parseMrUrl(v) ? undefined : 'Not a merge request URL'),
    });
    const ref = input ? parseMrUrl(input) : undefined;
    if (!ref) return;
    if (ref.baseUrl !== baseUrl) throw new Error(`This MR is on ${ref.baseUrl}, but Ripple is configured for ${baseUrl}.`);
    projectRef = ref.projectPath;
    iid = ref.iid;
  } else {
    projectRef = picked.mr!.project_id;
    iid = picked.mr!.iid;
  }

  await checkoutAndStart(app, projectRef, iid);
}

/**
 * Check out an MR into the project's review worktree (your clones stay untouched) and review it in this window.
 * Files outside the workspace still get language features: TS/JS find the nearest tsconfig themselves.
 */
export async function checkoutAndStart(app: App, projectRef: number | string, iid: number) {
  const token = await getGitLabToken(true);
  const baseUrl = configuredBaseUrl();
  const client = app.client(baseUrl);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Opening !${iid}` },
    async (progress) => {
      const report = (message: string) => progress.report({ message });
      report('Loading merge request…');
      const [project, mr] = await timed('api: project + MR', async () => {
        if (typeof projectRef === 'number') {
          return Promise.all([client.project(projectRef), client.mergeRequest(projectRef, iid)]);
        }
        const p = await client.project(projectRef);
        return [p, await client.mergeRequest(p.id, iid)] as const;
      });

      // Close the previous review first: its files are about to change underneath it.
      if (app.session) {
        await closeReviewTabs(app.session);
        app.session.dispose();
      }

      const paths = await timed('checkout total', () =>
        ensureCheckout(project, mr, {
          token,
          report,
          confirmDiscard,
        }),
      );
      const entry: WorktreeEntry = { baseUrl, projectId: project.id, projectPath: project.path_with_namespace, iid, ...paths };
      await app.store.registerWorktree(entry);
      await app.start(entry, mr, report);
    },
  );
}

export async function confirmDiscard(worktree: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    'The review checkout has local changes. Discard them to switch versions?',
    { modal: true, detail: worktree },
    'Discard Changes',
  );
  return choice === 'Discard Changes';
}

/** Close diff tabs that belong to a review, so switching MRs doesn't leave stale editors. */
async function closeReviewTabs(s: ReviewSession) {
  const inReview = (u: unknown) =>
    u instanceof vscode.Uri && (u.scheme === GIT_SCHEME || u.fsPath.startsWith(s.entry.worktree));
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => {
    const input = t.input;
    if (input instanceof vscode.TabInputTextDiff) return inReview(input.original) || inReview(input.modified);
    if (input instanceof vscode.TabInputText) return inReview(input.uri);
    return false;
  });
  if (tabs.length) await vscode.window.tabGroups.close(tabs);
}

async function pickMr(client: GitLabClient): Promise<MrPick | undefined> {
  const qp = vscode.window.createQuickPick<MrPick>();
  qp.title = 'Open merge request';
  qp.placeholder = 'Pick an MR or paste a URL';
  qp.matchOnDescription = true;
  qp.busy = true;
  const paste: MrPick = { label: '$(link) Paste merge request URL…', paste: true, alwaysShow: true };
  qp.items = [paste];
  qp.show();

  void (async () => {
    try {
      const me = await client.currentUser();
      const [review, assigned] = await Promise.all([client.reviewRequests(me.username), client.assignedToMe()]);
      const toItem = (mr: GlMergeRequest): MrPick => ({
        label: `!${mr.iid} ${mr.title}`,
        description: mr.references?.full?.replace(/!\d+$/, '') ?? '',
        detail: `${mr.author.name} · ${mr.source_branch} → ${mr.target_branch}`,
        mr,
      });
      qp.items = [
        paste,
        { label: 'Review requested', kind: vscode.QuickPickItemKind.Separator },
        ...review.map(toItem),
        { label: 'Assigned to me', kind: vscode.QuickPickItemKind.Separator },
        ...assigned.map(toItem),
      ];
    } catch (e) {
      qp.placeholder = `Could not load your MRs (${e instanceof Error ? e.message : e}). Paste a URL instead.`;
    } finally {
      qp.busy = false;
    }
  })();

  return new Promise((resolve) => {
    qp.onDidAccept(() => {
      resolve(qp.selectedItems[0]);
      qp.hide();
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });
  });
}

async function cleanupWorktrees(app: App) {
  const { store } = app;
  const entries = Object.values(store.worktrees());
  const stale: WorktreeEntry[] = [];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking MR states…' }, async () => {
    for (const e of entries) {
      const mr = await app.client(e.baseUrl).mergeRequest(e.projectId, e.iid).catch(() => undefined);
      if (!mr || mr.state === 'merged' || mr.state === 'closed') stale.push(e);
    }
  });
  if (!stale.length) {
    void vscode.window.showInformationMessage('No worktrees for closed or merged MRs.');
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    `Remove ${stale.length} worktree${stale.length === 1 ? '' : 's'} for closed/merged MRs?`,
    { modal: true, detail: stale.map((e) => `${e.projectPath} !${e.iid}\n  ${e.worktree}`).join('\n') + '\n\nAny local edits in them are lost.' },
    'Remove',
  );
  if (ok !== 'Remove') return;
  for (const e of stale) {
    if (store.activeReview()?.worktree === e.worktree) continue;
    await removeWorktree(e).catch(() => undefined);
    await store.unregisterWorktree(e.worktree);
  }
}
