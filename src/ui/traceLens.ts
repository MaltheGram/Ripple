import * as vscode from 'vscode';
import { changedSymbols } from '../analysis/symbols';
import { locate } from './diff';
import type { ReviewSession } from './session';

/** "Trace callers & callees" above every function/component the MR changed (new side of the diff). */
export class TraceLens implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly cache = new Map<string, Promise<vscode.CodeLens[]>>();

  constructor(private readonly session: () => ReviewSession | undefined) {}

  /** Session or MR version changed. */
  refresh() {
    this.cache.clear();
    this.changed.fire();
  }

  dispose() {
    this.changed.dispose();
  }

  provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> | vscode.CodeLens[] {
    const s = this.session();
    if (!s || !vscode.workspace.getConfiguration('ripple').get('traceCodeLens', true)) return [];
    const loc = locate(s, doc.uri);
    if (!loc || loc.side !== 'new') return [];
    const key = `${s.refs.head_sha}:${loc.file.path}:${doc.version}`;
    let lenses = this.cache.get(key);
    if (!lenses) {
      lenses = changedSymbols(s, loc.file).then((syms) =>
        syms.map(
          (sym) =>
            new vscode.CodeLens(new vscode.Range(sym.selection.start, sym.selection.start), {
              title: '$(type-hierarchy) Trace callers & callees',
              tooltip: `Who calls ${sym.name} (up to controllers, components, jobs and tests) and what it calls`,
              command: 'ripple.trace',
              arguments: [{ uri: doc.uri.toString(), line: sym.selection.start.line, character: sym.selection.start.character }],
            }),
        ),
      );
      lenses.catch(() => this.cache.delete(key));
      this.cache.set(key, lenses);
    }
    return lenses;
  }
}
