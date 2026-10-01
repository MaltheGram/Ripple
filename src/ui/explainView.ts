import * as vscode from 'vscode';
import { askFollowUp, explanationToDraft, openCause, type ExplainResult } from '../ai/explain';
import { explainMarkdown, VERDICT_LABEL } from './explainDoc';
import type { ReviewSession } from './session';

export const EXPLAIN_VIEW_ID = 'ripple.explain';
export const EXPLAIN_DOC_SCHEME = 'ripple-explain';
const MAX_HISTORY = 30;

interface Entry {
  id: number;
  result: ExplainResult;
}

type Node =
  | { kind: 'entry'; entry: Entry }
  | { kind: 'effect'; entry: Entry; index: number }
  | { kind: 'check'; entry: Entry; index: number }
  | { kind: 'followup'; entry: Entry; index: number };

const FOCUS_GROUP = [
  'workbench.action.focusFirstEditorGroup',
  'workbench.action.focusSecondEditorGroup',
  'workbench.action.focusThirdEditorGroup',
  'workbench.action.focusFourthEditorGroup',
  'workbench.action.focusFifthEditorGroup',
  'workbench.action.focusSixthEditorGroup',
  'workbench.action.focusSeventhEditorGroup',
  'workbench.action.focusEighthEditorGroup',
];

const VERDICT_ICON: Record<ExplainResult['answer']['verdict'], [string, string]> = {
  changed: ['diff-modified', 'gitDecoration.modifiedResourceForeground'],
  affected: ['warning', 'charts.orange'],
  unaffected: ['pass', 'gitDecoration.addedResourceForeground'],
  unclear: ['question', 'descriptionForeground'],
};

/**
 * "Explain" list in the sidebar. Each explanation is a markdown document (opened as a preview beside the code);
 * expanding one shows its effects (click → the causing change), checks and follow-ups.
 */
export class ExplainView implements vscode.TreeDataProvider<Node>, vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly treeChanged = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.treeChanged.event;
  private readonly docChanged = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.docChanged.event;
  private readonly view: vscode.TreeView<Node>;
  private session?: ReviewSession;
  private entries: Entry[] = [];
  private current?: Entry;
  private nextId = 1;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.view = vscode.window.createTreeView(EXPLAIN_VIEW_ID, { treeDataProvider: this });
  }

  dispose() {
    this.view.dispose();
    this.treeChanged.dispose();
    this.docChanged.dispose();
  }

  /** New review session: the list belongs to the previous MR. */
  setSession(s: ReviewSession | undefined) {
    if (s === this.session) return;
    this.session = s;
    this.entries = [];
    this.refresh();
  }

  /** Add (or refresh) an explanation and open its document. */
  async show(r: ExplainResult) {
    let entry = this.entries.find((e) => sameTarget(e.result, r));
    if (entry) entry.result = r;
    else {
      entry = { id: this.nextId++, result: r };
      this.entries.unshift(entry);
      this.entries = this.entries.slice(0, MAX_HISTORY);
    }
    this.refresh();
    this.docChanged.fire(this.uri(entry));
    await this.open(entry, { keepFocus: true });
    void this.view.reveal({ kind: 'entry', entry }, { select: true, focus: false }).then(undefined, () => undefined);
  }

  /** The explanation last shown or opened from the list (what "ask" and "add as comment" act on by default). */
  get shown(): ExplainResult | undefined {
    return (this.current && this.entries.includes(this.current) ? this.current : this.entries[0])?.result;
  }

  async ask(question: string, target?: ExplainResult): Promise<string> {
    const s = this.need();
    const r = target ?? this.shown;
    if (!r) throw new Error('Explain some code first (Alt+E).');
    const answer = await askFollowUp(s, this.context, r, question);
    const entry = this.entries.find((e) => e.result === r);
    if (entry) {
      this.refresh();
      this.docChanged.fire(this.uri(entry));
      await this.open(entry, { keepFocus: true });
    }
    return answer;
  }

  // ── commands (tree items pass their node) ────────────────────────────────

  async openNode(node: Node) {
    if (node.kind === 'effect') {
      const c = node.entry.result.answer.effects[node.index].cause;
      return openCause(this.need(), c.file, c.line);
    }
    return this.open(node.entry);
  }

  async askAbout(node?: Node) {
    const r = node?.entry.result ?? this.shown;
    if (!r) throw new Error('Explain some code first (Alt+E).');
    const q = await vscode.window.showInputBox({ title: `Ask about ${r.target.label}`, placeHolder: 'e.g. What happens if page is 0?', ignoreFocusOut: true });
    if (q) await this.ask(q, r);
  }

  async comment(node?: Node) {
    const r = node?.entry.result ?? this.shown;
    if (!r) throw new Error('Explain some code first (Alt+E).');
    const what = node?.kind === 'effect' ? 'effect' : node?.kind === 'check' ? 'check' : 'all';
    const index = node && 'index' in node ? node.index : 0;
    void vscode.window.showInformationMessage(await explanationToDraft(this.need(), r, what, index));
  }

  remove(node?: Node) {
    if (node) this.entries = this.entries.filter((e) => e !== node.entry);
    else this.entries = [];
    this.refresh();
  }

  // ── tree ─────────────────────────────────────────────────────────────────

  getChildren(node?: Node): Node[] {
    if (!node) return this.entries.map((entry) => ({ kind: 'entry', entry }));
    if (node.kind !== 'entry') return [];
    const r = node.entry.result;
    return [
      ...r.answer.effects.map((_, index) => ({ kind: 'effect' as const, entry: node.entry, index })),
      ...r.answer.checks.map((_, index) => ({ kind: 'check' as const, entry: node.entry, index })),
      ...r.followUps.map((_, index) => ({ kind: 'followup' as const, entry: node.entry, index })),
    ];
  }

  getParent(node: Node): Node | undefined {
    return node.kind === 'entry' ? undefined : { kind: 'entry', entry: node.entry };
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const r = node.entry.result;
    const t = r.target;
    if (node.kind === 'entry') {
      const item = new vscode.TreeItem(t.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `explain:${node.entry.id}`;
      item.description = `${t.rel.split('/').pop()}:${t.first + 1}${t.side === 'old' ? ' (old)' : ''}`;
      const [icon, color] = VERDICT_ICON[r.answer.verdict];
      item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
      item.tooltip = new vscode.MarkdownString(`**${VERDICT_LABEL[r.answer.verdict]}**\n\n${r.answer.summary}`);
      item.contextValue = 'explanation';
      item.command = { command: 'ripple.explain.open', title: 'Open explanation', arguments: [node] };
      return item;
    }
    if (node.kind === 'effect') {
      const e = r.answer.effects[node.index];
      const item = new vscode.TreeItem(`${e.kind}: ${e.description}`);
      item.id = `explain:${node.entry.id}:effect:${node.index}`;
      item.description = `${e.cause.file.split('/').pop()}${e.cause.line ? `:${e.cause.line}` : ''}`;
      item.tooltip = `${e.description}\n\nCaused by ${e.cause.file}${e.cause.line ? `:${e.cause.line}` : ''}${e.cause.symbol ? ` (${e.cause.symbol})` : ''}`;
      item.iconPath = new vscode.ThemeIcon('arrow-right');
      item.contextValue = 'explainEffect';
      item.command = { command: 'ripple.explain.open', title: 'Open the cause', arguments: [node] };
      return item;
    }
    if (node.kind === 'check') {
      const item = new vscode.TreeItem(r.answer.checks[node.index]);
      item.id = `explain:${node.entry.id}:check:${node.index}`;
      item.iconPath = new vscode.ThemeIcon('checklist');
      item.contextValue = 'explainCheck';
      item.command = { command: 'ripple.explain.open', title: 'Open explanation', arguments: [node] };
      return item;
    }
    const f = r.followUps[node.index];
    const item = new vscode.TreeItem(f.question);
    item.id = `explain:${node.entry.id}:followup:${node.index}`;
    item.iconPath = new vscode.ThemeIcon('comment-discussion');
    item.tooltip = new vscode.MarkdownString(f.answer);
    item.command = { command: 'ripple.explain.open', title: 'Open explanation', arguments: [node] };
    return item;
  }

  // ── documents ────────────────────────────────────────────────────────────

  provideTextDocumentContent(uri: vscode.Uri): string {
    const entry = this.entries.find((e) => String(e.id) === uri.query);
    const s = this.session;
    return entry && s ? explainMarkdown(entry.result, s.entry.worktree) : '_This explanation is no longer available (window reloaded or another MR opened)._';
  }

  private uri(entry: Entry): vscode.Uri {
    const name = entry.result.target.label.replace(/[\\/:*?"<>|]/g, '_');
    return vscode.Uri.from({ scheme: EXPLAIN_DOC_SCHEME, path: `/Explain ${name}.md`, query: String(entry.id) });
  }

  /**
   * Open the explanation beside the code. `keepFocus` puts focus back on the editor group you were in (diff or
   * file stays as it was), so reviewing and Alt+E continue.
   */
  private async open(entry: Entry, { keepFocus = false } = {}) {
    this.current = entry;
    const column = vscode.window.tabGroups.activeTabGroup.viewColumn;
    await vscode.commands.executeCommand('markdown.showPreviewToSide', this.uri(entry));
    const focus = FOCUS_GROUP[column - 1];
    if (keepFocus && focus) await vscode.commands.executeCommand(focus);
  }

  private refresh() {
    this.view.description = this.entries.length ? `${this.entries.length}` : undefined;
    void vscode.commands.executeCommand('setContext', 'ripple.hasExplanations', this.entries.length > 0);
    this.treeChanged.fire(undefined);
  }

  private need(): ReviewSession {
    if (!this.session) throw new Error('No merge request is open in this window.');
    return this.session;
  }
}

function sameTarget(a: ExplainResult, b: ExplainResult): boolean {
  const x = a.target;
  const y = b.target;
  return x.rel === y.rel && x.first === y.first && x.last === y.last && x.side === y.side && a.key === b.key;
}
