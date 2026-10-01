import * as path from 'node:path';
import * as vscode from 'vscode';
import { getGitLabToken } from '../auth/gitlabAuth';
import type { ChangedFile } from '../core/types';
import { git } from '../repo/git';
import type { ReviewSession } from './session';

export const GIT_SCHEME = 'ripple';
const EMPTY_REF = 'empty';

/**
 * Read-only file contents at a commit: `ripple:/<path>?ref=<sha>&gitDir=<dir>`.
 * The path stays in the URI path so VS Code picks the right language mode.
 */
export class GitContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = new URLSearchParams(uri.query);
    const ref = q.get('ref');
    const gitDir = q.get('gitDir');
    if (!ref || ref === EMPTY_REF || !gitDir) return '';
    const token = await getGitLabToken(false).catch(() => undefined);
    return git(['show', `${ref}:${uri.path.slice(1)}`], { cwd: gitDir, token, allowFailure: true });
  }
}

export function gitUri(relPath: string, ref: string, gitDir: string): vscode.Uri {
  return vscode.Uri.from({ scheme: GIT_SCHEME, path: `/${relPath}`, query: new URLSearchParams({ ref, gitDir }).toString() });
}

export function gitUriRef(uri: vscode.Uri): string | undefined {
  return new URLSearchParams(uri.query).get('ref') ?? undefined;
}

/** Left = base version (virtual), right = the real file in the MR worktree so CMD+click works. */
export function diffUris(s: ReviewSession, f: ChangedFile): { left: vscode.Uri; right: vscode.Uri } {
  const { gitDir, worktree } = s.entry;
  // "Since your review": show only what changed after the version you reviewed.
  const since = s.state.filters.sinceReview && s.since?.files.has(f.path) ? s.since.base : undefined;
  const left = since ? gitUri(f.path, since, gitDir) : gitUri(f.oldPath, f.change === 'added' ? EMPTY_REF : s.refs.base_sha, gitDir);
  const right =
    f.change === 'deleted' ? gitUri(f.path, EMPTY_REF, gitDir) : vscode.Uri.file(path.join(worktree, f.path));
  return { left, right };
}

export async function openDiff(s: ReviewSession, f: ChangedFile) {
  const { left, right } = diffUris(s, f);
  const label = f.change === 'renamed' ? `${f.oldPath} → ${f.path}` : f.path;
  const since = s.state.filters.sinceReview && s.since?.files.has(f.path) ? ` since ${s.since.label}` : '';
  await vscode.commands.executeCommand('vscode.diff', left, right, `${label} (!${s.entry.iid}${since})`, { preview: true });
  await s.setLastOpened(f.path);
}

/** Open the diff and put the cursor on a 1-based line of the new file. */
export async function revealInDiff(s: ReviewSession, f: ChangedFile, newLine: number) {
  await openDiff(s, f);
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const pos = new vscode.Position(Math.max(0, newLine - 1), 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

/** Which MR file and side a document belongs to, for comments and "current file" lookups. */
export function locate(s: ReviewSession, uri: vscode.Uri): { file: ChangedFile; side: 'old' | 'new' } | undefined {
  if (uri.scheme === 'file') {
    const rel = path.relative(s.entry.worktree, uri.fsPath).split(path.sep).join('/');
    if (rel.startsWith('..')) return undefined;
    const file = s.files.find((f) => f.path === rel && f.change !== 'deleted');
    return file && { file, side: 'new' };
  }
  if (uri.scheme === GIT_SCHEME && gitUriRef(uri) === s.refs.base_sha) {
    const rel = uri.path.slice(1);
    const file = s.files.find((f) => f.oldPath === rel && f.change !== 'added');
    return file && { file, side: 'old' };
  }
  return undefined;
}
