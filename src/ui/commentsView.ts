import * as vscode from 'vscode';
import { commentLabel } from '../core/commentLabels';
import { positionForOldLine } from '../core/lineMap';
import type { GlDiscussion, GlDraftNote, GlPosition } from '../gitlab/types';
import { revealInDiff } from './diff';
import { overviewUri } from './overview';
import type { ReviewSession } from './session';

type Section = 'general' | 'unresolved' | 'resolved' | 'drafts';
type Node =
  | { kind: 'section'; section: Section; count: number }
  | { kind: 'file'; section: Section; path: string; items: Item[] }
  | { kind: 'item'; item: Item };

interface Item {
  id: string;
  text: string;
  author: string;
  replies: number;
  position?: GlPosition | null;
  draft: boolean;
}

const SECTIONS: { section: Section; label: string; icon: string; open: boolean }[] = [
  { section: 'general', label: 'General', icon: 'comment-discussion', open: true },
  { section: 'unresolved', label: 'Unresolved', icon: 'comment-unresolved', open: true },
  { section: 'drafts', label: 'Your drafts', icon: 'edit', open: true },
  { section: 'resolved', label: 'Resolved', icon: 'pass', open: false },
];

/** "Comments" sidebar: every thread on the MR, grouped, click to jump. */
export class CommentsView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: vscode.TreeView<Node>;
  private session?: ReviewSession;
  private sub?: vscode.Disposable;

  constructor() {
    this.view = vscode.window.createTreeView('ripple.comments', { treeDataProvider: this });
  }

  setSession(s: ReviewSession | undefined) {
    this.sub?.dispose();
    this.session = s;
    this.sub = s?.onDidChangeComments(() => this.refresh());
    this.refresh();
  }

  dispose() {
    this.sub?.dispose();
    this.view.dispose();
    this.changed.dispose();
  }

  private refresh() {
    const g = this.groups();
    const unresolved = g.unresolved.length;
    this.view.description = this.session ? `${unresolved} unresolved${g.drafts.length ? ` · ${g.drafts.length} draft${g.drafts.length === 1 ? '' : 's'}` : ''}` : undefined;
    this.view.badge = unresolved ? { value: unresolved, tooltip: `${unresolved} unresolved threads` } : undefined;
    this.changed.fire();
  }

  getChildren(node?: Node): Node[] {
    if (!this.session) return [];
    const g = this.groups();
    if (!node) return SECTIONS.map(({ section }) => ({ kind: 'section', section, count: g[section].length }));
    if (node.kind === 'file') return node.items.map((item) => ({ kind: 'item', item }));
    if (node.kind !== 'section') return [];

    const items = g[node.section];
    if (node.section === 'general') return items.map((item) => ({ kind: 'item', item }));
    const byFile = new Map<string, Item[]>();
    for (const it of items) {
      const p = it.position ? (it.position.new_path ?? it.position.old_path ?? '') : '(general)';
      if (!byFile.has(p)) byFile.set(p, []);
      byFile.get(p)!.push(it);
    }
    return [...byFile].map(([path, list]) => ({ kind: 'file', section: node.section, path, items: list }));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'section') {
      const meta = SECTIONS.find((x) => x.section === node.section)!;
      const item = new vscode.TreeItem(meta.label, meta.open ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `section:${node.section}`;
      item.description = String(node.count);
      item.iconPath = new vscode.ThemeIcon(meta.icon);
      return item;
    }
    if (node.kind === 'file') {
      const item = new vscode.TreeItem(node.path.split('/').pop() ?? node.path, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `file:${node.section}:${node.path}`;
      item.description = `${node.path.split('/').slice(0, -1).join('/')} · ${node.items.length}`;
      item.resourceUri = vscode.Uri.file(node.path);
      item.iconPath = vscode.ThemeIcon.File;
      return item;
    }
    const it = node.item;
    const line = it.position?.new_line ?? it.position?.old_line;
    const item = new vscode.TreeItem(oneLine(it.text.replace(/^\s*\*\*[^*]+:\*\*\s*/, '')));
    item.id = `item:${it.id}`;
    item.description = [commentLabel(it.text), line ? `L${line}` : undefined, it.author, it.replies ? `${it.replies} repl${it.replies === 1 ? 'y' : 'ies'}` : undefined]
      .filter(Boolean)
      .join(' · ');
    item.tooltip = new vscode.MarkdownString(`**${it.author}**${it.draft ? ' (draft)' : ''}\n\n${it.text}`);
    const label = commentLabel(it.text);
    item.iconPath = new vscode.ThemeIcon(it.draft ? 'edit' : label?.includes('blocking') ? 'error' : label === 'question' ? 'question' : 'comment');
    item.command = { command: 'ripple.goToComment', title: 'Go to comment', arguments: [it.position ?? null] };
    return item;
  }

  private groups(): Record<Section, Item[]> {
    const out: Record<Section, Item[]> = { general: [], unresolved: [], resolved: [], drafts: [] };
    const s = this.session;
    if (!s) return out;
    for (const d of s.discussions) {
      const notes = d.notes.filter((n) => !n.system);
      if (!notes.length) continue;
      const item = fromDiscussion(d, notes);
      if (!notes[0].position) out.general.push(item);
      else if (isResolved(d)) out.resolved.push(item);
      else out.unresolved.push(item);
    }
    for (const d of s.drafts) {
      // A draft reply lives where its thread lives.
      const thread = d.discussion_id ? s.discussions.find((x) => x.id === d.discussion_id) : undefined;
      out.drafts.push({ ...fromDraft(d, s.me?.name ?? 'You'), position: d.position ?? thread?.notes[0]?.position ?? null });
    }
    return out;
  }
}

/** Unresolved line threads in review order (visible file order, then line), for "next unresolved thread". */
export function unresolvedInOrder(s: ReviewSession): GlPosition[] {
  const order = new Map(s.visibleFiles().map((f, i) => [f.path, i]));
  const all = s.files.map((f) => f.path);
  const rank = (p: GlPosition) => order.get(p.new_path ?? p.old_path ?? '') ?? order.size + all.indexOf(p.new_path ?? p.old_path ?? '');
  return s.discussions
    .filter((d) => d.notes[0]?.position && !d.notes[0].system && d.notes.some((n) => n.resolvable && !n.resolved))
    .map((d) => d.notes[0].position!)
    .sort((a, b) => rank(a) - rank(b) || (a.new_line ?? a.old_line ?? 0) - (b.new_line ?? b.old_line ?? 0));
}

/** Jump to where a comment lives: its diff line, or the MR overview for general comments. */
export async function goToComment(s: ReviewSession, position: GlPosition | null) {
  if (!position) {
    await vscode.window.showTextDocument(overviewUri(s), { preview: true });
    return;
  }
  const file = s.fileByPath(position.new_path ?? position.old_path ?? '');
  if (!file) {
    void vscode.window.showInformationMessage('That file is not part of the current MR version.');
    return;
  }
  let line = position.new_line ?? undefined;
  if (!line && position.old_line) {
    // Comment on a removed line: land on the nearest line of the new side.
    line = positionForOldLine(file.hunks, position.old_line).new_line ?? file.hunks.find((h) => h.oldStart <= position.old_line! && position.old_line! < h.oldStart + h.oldLines)?.newStart ?? 1;
  }
  await revealInDiff(s, file, line ?? 1);
}

function fromDiscussion(d: GlDiscussion, notes: GlDiscussion['notes']): Item {
  return { id: d.id, text: notes[0].body, author: notes[0].author.name, replies: notes.length - 1, position: notes[0].position, draft: false };
}

function fromDraft(d: GlDraftNote, me: string): Item {
  return { id: `draft:${d.id}`, text: d.note, author: me, replies: 0, position: d.position, draft: true };
}

function isResolved(d: GlDiscussion): boolean {
  const resolvable = d.notes.filter((n) => n.resolvable);
  return resolvable.length > 0 && resolvable.every((n) => n.resolved);
}

function oneLine(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}
