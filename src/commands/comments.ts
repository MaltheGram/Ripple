import * as vscode from 'vscode';
import type { GlPosition } from '../gitlab/types';
import type { BrComment } from '../ui/comments';
import { goToComment, unresolvedInOrder } from '../ui/commentsView';
import { locate } from '../ui/diff';
import type { App } from '../app';

/** Inline comment threads, drafts, suggestions and jumping to comments. */
export function registerCommentCommands(app: App) {
  const { comments } = app;
  app.command('ripple.comment.addDraft', (reply: vscode.CommentReply) => comments.addDraft(reply));
  app.command('ripple.comment.postNow', (reply: vscode.CommentReply) => comments.postNow(reply));
  app.command('ripple.comment.resolve', (t: vscode.CommentThread) => comments.setResolved(t, true));
  app.command('ripple.comment.unresolve', (t: vscode.CommentThread) => comments.setResolved(t, false));
  app.command('ripple.comment.deleteDraft', (c: BrComment) => comments.deleteDraft(c));
  app.command('ripple.comment.acceptSuggestion', (t: vscode.CommentThread) => comments.acceptSuggestion(t));
  app.command('ripple.comment.discardSuggestion', (t: vscode.CommentThread) => comments.discardSuggestion(t));
  app.command('ripple.nextThread', () => nextUnresolved(app));
  app.command('ripple.goToComment', (position: GlPosition | null) =>
    position ? goToComment(app.need(), position) : vscode.commands.executeCommand('ripple.openOverview'),
  );
}

/** Cycle through unresolved threads in review order, starting after the cursor. */
export async function nextUnresolved(app: App) {
  const s = app.need();
  const all = unresolvedInOrder(s);
  if (!all.length) {
    void vscode.window.showInformationMessage('No unresolved threads on this MR. 🎉');
    return;
  }
  const editor = vscode.window.activeTextEditor;
  const here = editor ? locate(s, editor.document.uri) : undefined;
  const line = editor ? editor.selection.active.line + 1 : 0;
  const fileRank = new Map(s.visibleFiles().map((f, i) => [f.path, i]));
  const hereRank = here ? (fileRank.get(here.file.path) ?? -1) : -1;
  const after = all.findIndex((p) => {
    const r = fileRank.get(p.new_path ?? p.old_path ?? '') ?? Number.MAX_SAFE_INTEGER;
    return r > hereRank || (r === hereRank && (p.new_line ?? p.old_line ?? 0) > line);
  });
  const target = all[after === -1 ? 0 : after];
  await goToComment(s, target);
  void vscode.window.setStatusBarMessage(`Unresolved thread ${all.indexOf(target) + 1} of ${all.length}`, 3000);
}
