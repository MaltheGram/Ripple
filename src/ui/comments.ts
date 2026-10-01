import * as path from 'node:path';
import * as vscode from 'vscode';
import { applyCommentLabel } from '../core/commentLabels';
import { lineRangeFor, positionForNewLine, positionForOldLine } from '../core/lineMap';
import type { ChangedFile } from '../core/types';
import type { GlNote, GlPosition, GlUser } from '../gitlab/types';
import { gitUri, locate } from './diff';
import { GENERAL_LINE, OVERVIEW_SCHEME, overviewUri } from './overview';
import type { ReviewSession } from './session';

interface ThreadMeta {
  discussionId?: string;
  /** AI suggestion not yet accepted: the comment text to send as a draft. */
  suggestion?: { file: string; body: string };
}

const SEVERITY_LABEL: Record<string, string> = { issue: '🐞 Issue', suggestion: '💡 Suggestion', question: '❓ Question', nit: '✏️ Nit' };

export class BrComment implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  constructor(
    public body: vscode.MarkdownString,
    public author: vscode.CommentAuthorInformation,
    public contextValue: 'note' | 'draft' | 'suggestion',
    public label?: string,
    public timestamp?: Date,
    readonly draftId?: number,
  ) {}
}

/** Renders MR discussions and draft notes inline in the diff editors and posts new ones. */
export class CommentsController implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController('ripple', 'GitLab MR');
  private readonly meta = new WeakMap<vscode.CommentThread, ThreadMeta>();
  private threads: vscode.CommentThread[] = [];
  /** AI suggestions live apart from GitLab threads so a comments reload doesn't wipe them. */
  private suggestions: vscode.CommentThread[] = [];
  private session?: ReviewSession;
  private sub?: vscode.Disposable;

  constructor() {
    this.controller.options = { prompt: 'Comment on this line', placeHolder: 'Markdown. Start with nit:, q:, s:, b: (blocking) or p: for a label. Select lines first for a multi-line comment. "Add to Review" saves a draft.' };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) => {
        const s = this.session;
        if (!s || doc.lineCount === 0) return [];
        if (doc.uri.scheme === OVERVIEW_SCHEME) return [new vscode.Range(GENERAL_LINE, 0, GENERAL_LINE, 0)];
        if (!locate(s, doc.uri)) return [];
        return [new vscode.Range(0, 0, doc.lineCount - 1, 0)];
      },
    };
  }

  setSession(s: ReviewSession | undefined) {
    this.sub?.dispose();
    this.clearSuggestions();
    this.session = s;
    this.sub = s?.onDidChangeComments(() => this.render());
    this.render();
  }

  dispose() {
    this.sub?.dispose();
    this.clear();
    this.clearSuggestions();
    this.controller.dispose();
  }

  // ── commands ───────────────────────────────────────────────────────────

  async addDraft(reply: vscode.CommentReply) {
    await this.submit(reply, true);
  }

  async postNow(reply: vscode.CommentReply) {
    await this.submit(reply, false);
  }

  async setResolved(thread: vscode.CommentThread, resolved: boolean) {
    const s = this.requireSession();
    const id = this.meta.get(thread)?.discussionId;
    if (!id) return;
    await s.client.setResolved(s.entry.projectId, s.entry.iid, id, resolved);
    await s.reloadComments();
  }

  async deleteDraft(comment: BrComment) {
    const s = this.requireSession();
    if (comment.draftId === undefined) return;
    await s.client.deleteDraft(s.entry.projectId, s.entry.iid, comment.draftId);
    await s.reloadComments();
  }

  /** Show AI review comments for one file as inline threads (replacing earlier ones for that file). */
  showSuggestions(s: ReviewSession, file: ChangedFile, items: { line: number; severity: string; body: string }[]) {
    const uri = vscode.Uri.file(path.join(s.entry.worktree, file.path));
    for (const t of this.suggestions.filter((t) => this.meta.get(t)?.suggestion?.file === file.path)) t.dispose();
    this.suggestions = this.suggestions.filter((t) => this.meta.get(t)?.suggestion?.file !== file.path);
    for (const it of items) {
      const label = SEVERITY_LABEL[it.severity] ?? it.severity;
      const comment = new BrComment(md(`**${label}**\n\n${it.body}`), { name: 'Claude (AI suggestion)' }, 'suggestion');
      const thread = this.controller.createCommentThread(uri, new vscode.Range(it.line - 1, 0, it.line - 1, 0), [comment]);
      thread.contextValue = 'suggestion';
      thread.label = 'AI suggestion: ✓ adds it as your draft, 🗑 discards';
      thread.canReply = false;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      this.meta.set(thread, { suggestion: { file: file.path, body: it.severity === 'nit' ? `Nit: ${it.body}` : it.body } });
      this.suggestions.push(thread);
    }
  }

  async acceptSuggestion(thread: vscode.CommentThread) {
    const s = this.requireSession();
    const sug = this.meta.get(thread)?.suggestion;
    if (!sug) return;
    await s.client.createDraft(s.entry.projectId, s.entry.iid, { note: sug.body, position: this.positionFor(s, thread) });
    this.discardSuggestion(thread);
    await s.reloadComments();
  }

  discardSuggestion(thread: vscode.CommentThread) {
    thread.dispose();
    this.suggestions = this.suggestions.filter((t) => t !== thread);
  }

  private clearSuggestions() {
    this.suggestions.forEach((t) => t.dispose());
    this.suggestions = [];
  }

  private async submit(reply: vscode.CommentReply, asDraft: boolean) {
    const s = this.requireSession();
    const { projectId, iid } = s.entry;
    const raw = reply.text.trim();
    if (!raw) return;
    const text = vscode.workspace.getConfiguration('ripple').get('commentLabels', true) ? applyCommentLabel(raw) : raw;
    const discussionId = this.meta.get(reply.thread)?.discussionId;

    if (discussionId) {
      if (asDraft) await s.client.createDraft(projectId, iid, { note: text, in_reply_to_discussion_id: discussionId });
      else await s.client.reply(projectId, iid, discussionId, text);
    } else if (reply.thread.uri.scheme === OVERVIEW_SCHEME) {
      // General comment on the whole MR: no position.
      if (asDraft) await s.client.createDraft(projectId, iid, { note: text });
      else await s.client.createDiscussion(projectId, iid, text);
    } else {
      const position = this.positionFor(s, reply.thread);
      if (asDraft) await s.client.createDraft(projectId, iid, { note: text, position });
      else await s.client.createDiscussion(projectId, iid, text, position);
    }
    // The thread VS Code created for a brand-new comment is replaced by the re-rendered one.
    if (!this.threads.includes(reply.thread)) reply.thread.dispose();
    await s.reloadComments();
  }

  private positionFor(s: ReviewSession, thread: vscode.CommentThread): GlPosition {
    const loc = locate(s, thread.uri);
    if (!loc || !thread.range) throw new Error('Comments can only be added to files changed in this MR.');
    return positionForLines(s, loc.file, loc.side, thread.range.start.line + 1, thread.range.end.line + 1);
  }

  // ── rendering ──────────────────────────────────────────────────────────

  private render() {
    this.clear();
    const s = this.session;
    if (!s) return;

    const byDiscussion = new Map<string, vscode.CommentThread>();
    for (const d of s.discussions) {
      const first = d.notes[0];
      if (!first || first.system) continue;
      const anchor = first.position ? this.anchor(s, first.position) : this.generalAnchor(s);
      if (!anchor) continue;
      const thread = this.controller.createCommentThread(anchor.uri, anchor.range, d.notes.filter((n) => !n.system).map(toComment));
      const resolvable = d.notes.some((n) => n.resolvable);
      const resolved = resolvable && d.notes.every((n) => !n.resolvable || n.resolved);
      thread.contextValue = resolvable ? (resolved ? 'resolved' : 'unresolved') : 'note';
      thread.state = resolvable ? (resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved) : undefined;
      thread.collapsibleState = resolved ? vscode.CommentThreadCollapsibleState.Collapsed : vscode.CommentThreadCollapsibleState.Expanded;
      thread.canReply = true;
      if (first.position?.head_sha && first.position.head_sha !== s.refs.head_sha) {
        const changed = s.changedSinceThread(first.position.head_sha, first.position.new_path ?? first.position.old_path);
        thread.label = changed && resolvable && !resolved ? 'Code changed since this comment: maybe addressed?' : 'Earlier version';
      }
      this.meta.set(thread, { discussionId: d.id });
      byDiscussion.set(d.id, thread);
      this.threads.push(thread);
    }

    for (const draft of s.drafts) {
      const comment = new BrComment(
        md(draft.note),
        { name: s.me?.name ?? 'You', iconPath: avatar(s.me) },
        'draft',
        'Draft',
        undefined,
        draft.id,
      );
      const existing = draft.discussion_id ? byDiscussion.get(draft.discussion_id) : undefined;
      if (existing) {
        existing.comments = [...existing.comments, comment];
        continue;
      }
      const anchor = draft.position ? this.anchor(s, draft.position) : this.generalAnchor(s);
      if (!anchor) continue;
      const thread = this.controller.createCommentThread(anchor.uri, anchor.range, [comment]);
      thread.contextValue = 'draft';
      thread.label = 'Pending review';
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      this.meta.set(thread, {});
      this.threads.push(thread);
    }
  }

  private generalAnchor(s: ReviewSession) {
    return { uri: overviewUri(s), range: new vscode.Range(GENERAL_LINE, 0, GENERAL_LINE, 0) };
  }

  private anchor(s: ReviewSession, p: GlPosition): { uri: vscode.Uri; range: vscode.Range } | undefined {
    if (p.position_type !== 'text') return undefined;
    const start = p.line_range?.start;
    if (p.new_line && p.new_path) {
      const file = s.files.find((f) => f.path === p.new_path && f.change !== 'deleted');
      if (file) {
        return { uri: vscode.Uri.file(path.join(s.entry.worktree, file.path)), range: lineRange(start?.new_line ?? p.new_line, p.new_line) };
      }
    }
    if (p.old_line && p.old_path) {
      return { uri: gitUri(p.old_path, s.refs.base_sha, s.entry.gitDir), range: lineRange(start?.old_line ?? p.old_line, p.old_line) };
    }
    return undefined;
  }

  private clear() {
    this.threads.forEach((t) => t.dispose());
    this.threads = [];
  }

  private requireSession(): ReviewSession {
    if (!this.session) throw new Error('No merge request is open in this window.');
    return this.session;
  }
}

/**
 * GitLab position for a comment on 1-based lines `start..end` of one side of a file's diff.
 * GitLab anchors the comment on the last line; a multi-line selection also goes in `line_range`.
 */
export function positionForLines(s: ReviewSession, file: ChangedFile, side: 'old' | 'new', start: number, end: number): GlPosition {
  const { hunks } = file;
  const lines = side === 'new' ? positionForNewLine(hunks, end) : positionForOldLine(hunks, end);
  const codePath = file.change === 'deleted' ? file.oldPath : file.path;
  return {
    position_type: 'text',
    ...s.refs,
    old_path: file.oldPath,
    new_path: file.path,
    ...lines,
    ...(start < end ? { line_range: lineRangeFor(codePath, hunks, side, start, end) } : {}),
  };
}

function toComment(n: GlNote): BrComment {
  return new BrComment(md(n.body), { name: n.author.name, iconPath: avatar(n.author) }, 'note', undefined, new Date(n.created_at));
}

function md(body: string): vscode.MarkdownString {
  const m = new vscode.MarkdownString(body);
  m.supportHtml = false;
  return m;
}

function avatar(u: GlUser | undefined): vscode.Uri | undefined {
  return u?.avatar_url ? vscode.Uri.parse(u.avatar_url) : undefined;
}

/** 1-based inclusive lines → VS Code range. */
function lineRange(start: number, end: number): vscode.Range {
  return new vscode.Range(Math.min(start, end) - 1, 0, end - 1, 0);
}
