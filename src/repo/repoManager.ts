import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GlMergeRequest, GlProject } from '../gitlab/types';
import { timed } from '../log';
import { git } from './git';

export interface Checkout {
  gitDir: string;
  worktree: string;
}

export interface CheckoutOptions {
  token: string;
  report?: (message: string) => void;
  /** Called when the review checkout has local edits that block switching. Return true to discard them. */
  confirmDiscard?: (worktree: string) => Promise<boolean>;
}

export function storageRoot(): string {
  const raw = vscode.workspace.getConfiguration('ripple').get<string>('storageRoot', '~/.ripple');
  return path.resolve(raw.replace(/^~(?=$|\/)/, homedir()));
}

/**
 * One bare partial clone and one review worktree per project. Switching MRs moves the worktree,
 * so only changed files are downloaded and dependencies installed there survive between reviews.
 */
export function checkoutPaths(project: GlProject): Checkout {
  const root = storageRoot();
  return {
    gitDir: path.join(root, 'repos', `${project.path_with_namespace}.git`),
    worktree: path.join(root, 'worktrees', project.path_with_namespace.replace(/\//g, '__')),
  };
}

/** Local refs we keep per MR inside the bare clone. */
export function mrRefs(iid: number) {
  return { head: `refs/ripple/mr/${iid}/head`, target: `refs/ripple/mr/${iid}/target` };
}

/** Make sure the project's review worktree is at the MR head. Never touches the user's own clones. */
export async function ensureCheckout(project: GlProject, mr: GlMergeRequest, opts: CheckoutOptions): Promise<Checkout> {
  const c = checkoutPaths(project);
  const { base_sha, head_sha } = mr.diff_refs;

  if (!existsSync(c.gitDir)) {
    opts.report?.('Cloning repository (first time only)…');
    await mkdir(path.dirname(c.gitDir), { recursive: true });
    await timed('git clone', () =>
      git(['clone', '--bare', '--filter=blob:none', '--no-tags', project.http_url_to_repo, c.gitDir], {
        cwd: path.dirname(c.gitDir),
        token: opts.token,
      }),
    );
  }

  // Symlinks from the MR become plain files: a link to ~/.ssh/… must never be followed by reads or the editor.
  await git(['config', 'core.symlinks', 'false'], { cwd: c.gitDir });

  // Fast path: both commits already here → no network.
  if (!(await hasCommits(c.gitDir, [base_sha, head_sha]))) {
    opts.report?.('Fetching merge request…');
    await timed('git fetch', () => fetchMr(c.gitDir, mr, opts.token));
  }

  if (!existsSync(c.worktree)) {
    opts.report?.('Checking out files (first time for this project)…');
    await mkdir(path.dirname(c.worktree), { recursive: true });
    await git(['worktree', 'prune'], { cwd: c.gitDir });
    await timed('git worktree add', () =>
      git(['worktree', 'add', '--detach', c.worktree, head_sha], { cwd: c.gitDir, token: opts.token }),
    );
  } else {
    await moveWorktree(c, head_sha, opts);
  }
  return c;
}

export async function fetchMr(gitDir: string, mr: GlMergeRequest, token: string) {
  const refs = mrRefs(mr.iid);
  await git(
    [
      'fetch',
      '--no-tags',
      '--force',
      'origin',
      `refs/merge-requests/${mr.iid}/head:${refs.head}`,
      `refs/heads/${mr.target_branch}:${refs.target}`,
    ],
    { cwd: gitDir, token },
  );
}

/** Move the worktree to `sha`. Asks before discarding local edits there. */
export async function moveWorktree(c: Checkout, sha: string, opts: CheckoutOptions) {
  const current = (await git(['rev-parse', 'HEAD'], { cwd: c.worktree })).trim();
  if (current === sha) return;

  const dirty = (await git(['status', '--porcelain', '--untracked-files=no'], { cwd: c.worktree })).trim();
  let force = false;
  if (dirty) {
    force = (await opts.confirmDiscard?.(c.worktree)) ?? false;
    if (!force) throw new Error(`The review checkout has local changes, so it can't switch MRs:\n${c.worktree}`);
  }
  opts.report?.('Switching files…');
  await timed('git checkout', () =>
    git(['checkout', '--detach', ...(force ? ['--force'] : []), sha], { cwd: c.worktree, token: opts.token }),
  );
}

export async function removeWorktree(c: Checkout) {
  await git(['worktree', 'remove', '--force', c.worktree], { cwd: c.gitDir });
}

async function hasCommits(gitDir: string, shas: string[]): Promise<boolean> {
  const out = await git(['cat-file', '--batch-check'], { cwd: gitDir, allowFailure: true, noLazyFetch: true, input: shas.join('\n') + '\n' });
  return out.split('\n').filter((l) => / commit /.test(l)).length === shas.length;
}
