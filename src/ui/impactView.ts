import * as path from 'node:path';
import * as vscode from 'vscode';
import { impactOf, type Caller } from '../analysis/impact';
import { symbolLabel, type ChangedSymbol } from '../analysis/symbols';
import type { ChangedFile } from '../core/types';
import { log } from '../log';
import { locate } from './diff';
import type { ReviewSession } from './session';

type Impact = { symbol: ChangedSymbol; callers: Caller[] }[];
type Node =
  | { kind: 'symbol'; entry: Impact[number] }
  | { kind: 'caller'; caller: Caller }
  | { kind: 'message'; text: string };

const SYMBOL_ICON: Partial<Record<vscode.SymbolKind, string>> = {
  [vscode.SymbolKind.Method]: 'symbol-method',
  [vscode.SymbolKind.Function]: 'symbol-function',
  [vscode.SymbolKind.Constructor]: 'symbol-method',
  [vscode.SymbolKind.Class]: 'symbol-class',
};

/** "Impact" sidebar: for the file in the active diff, which functions changed and who calls them. */
export class ImpactView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: vscode.TreeView<Node>;
  private readonly disposables: vscode.Disposable[] = [];
  private session?: ReviewSession;
  private file?: ChangedFile;
  private cache = new Map<string, Promise<Impact>>();
  private timer?: NodeJS.Timeout;

  constructor() {
    this.view = vscode.window.createTreeView('ripple.impact', { treeDataProvider: this });
    this.disposables.push(
      this.view,
      this.changed,
      vscode.window.onDidChangeActiveTextEditor(() => this.follow()),
      this.view.onDidChangeVisibility((e) => (e.visible ? this.changed.fire() : undefined)),
    );
  }

  setSession(s: ReviewSession | undefined) {
    this.session = s;
    this.cache.clear();
    this.file = undefined;
    this.follow();
  }

  /** Forget cached results, e.g. after the MR got new commits. */
  reset() {
    this.cache.clear();
    this.changed.fire();
  }

  dispose() {
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }

  private follow() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const s = this.session;
      const editor = vscode.window.activeTextEditor;
      const hit = s && editor ? locate(s, editor.document.uri) : undefined;
      if (hit && hit.file.path !== this.file?.path) {
        this.file = hit.file;
        this.changed.fire();
      } else if (!s && this.file) {
        this.file = undefined;
        this.changed.fire();
      }
    }, 300);
  }

  async getChildren(node?: Node): Promise<Node[]> {
    const s = this.session;
    if (!s) return [];
    if (!node) {
      const f = this.file;
      if (!f) return [{ kind: 'message', text: 'Open a file from the Review list to see its impact.' }];
      this.view.description = path.posix.basename(f.path);
      if (!this.view.visible) return [];
      const impact = await this.load(s, f);
      if (!impact.length) return [{ kind: 'message', text: 'No changed functions found (or the language server has none).' }];
      return impact.map((entry) => ({ kind: 'symbol', entry }));
    }
    if (node.kind === 'symbol') {
      if (!node.entry.callers.length) return [{ kind: 'message', text: 'No callers found' }];
      return node.entry.callers.map((caller) => ({ kind: 'caller', caller }));
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'message') return new vscode.TreeItem(node.text);
    if (node.kind === 'symbol') {
      const { symbol, callers } = node.entry;
      const outside = callers.filter((c) => !c.inMr).length;
      const item = new vscode.TreeItem(symbolLabel(symbol), vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${symbol.change} · ${callers.length} caller${callers.length === 1 ? '' : 's'}${outside ? ` · ${outside} outside MR` : ''}`;
      item.iconPath = new vscode.ThemeIcon(
        SYMBOL_ICON[symbol.kind] ?? 'symbol-variable',
        new vscode.ThemeColor(outside ? 'list.warningForeground' : 'foreground'),
      );
      item.tooltip = outside
        ? `${outside} caller(s) are not part of this MR. Check they still work with the change.`
        : 'All callers are part of this MR.';
      item.command = openAt(symbol.uri, symbol.selection);
      item.contextValue = 'impactSymbol';
      return item;
    }
    const c = node.caller;
    const item = new vscode.TreeItem(c.label);
    const rel = this.session ? path.relative(this.session.entry.worktree, c.uri.fsPath) : c.uri.fsPath;
    item.description = `${c.inMr ? 'in MR · ' : ''}${rel}:${c.range.start.line + 1}`;
    item.iconPath = new vscode.ThemeIcon(c.inMr ? 'git-pull-request' : 'warning', c.inMr ? undefined : new vscode.ThemeColor('list.warningForeground'));
    item.command = openAt(c.uri, c.range);
    return item;
  }

  private load(s: ReviewSession, f: ChangedFile): Promise<Impact> {
    const key = `${s.refs.head_sha}:${f.path}`;
    let p = this.cache.get(key);
    if (!p) {
      p = Promise.resolve(vscode.window.withProgress({ location: { viewId: 'ripple.impact' } }, () => impactOf(s, f)));
      p.catch((e) => {
        log().error(`Impact for ${f.path} failed: ${e instanceof Error ? e.message : e}`);
        this.cache.delete(key);
      });
      this.cache.set(key, p);
    }
    return p;
  }
}

function openAt(uri: vscode.Uri, range: vscode.Range): vscode.Command {
  return { command: 'vscode.open', title: 'Open', arguments: [uri, { selection: range, preserveFocus: false }] };
}
