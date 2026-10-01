import * as vscode from 'vscode';
import { locate } from './diff';
import type { ReviewSession } from './session';

/** Marks changed lines that no test executed (from the pipeline's coverage report) on the new side of diffs. */
export class CoverageDecorations implements vscode.Disposable {
  private readonly type = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('testing.iconFailed'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    before: { contentText: '▍', color: new vscode.ThemeColor('testing.iconFailed'), margin: '0 4px 0 0' },
  });
  private readonly disposables: vscode.Disposable[];
  private sub?: vscode.Disposable;
  private session?: ReviewSession;

  constructor() {
    this.disposables = [this.type, vscode.window.onDidChangeVisibleTextEditors(() => this.paint())];
  }

  setSession(s: ReviewSession | undefined) {
    this.sub?.dispose();
    this.session = s;
    this.sub = s?.onDidChange(() => this.paint());
    this.paint();
  }

  dispose() {
    this.sub?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }

  private paint() {
    const s = this.session;
    const on = vscode.workspace.getConfiguration('ripple.coverage').get('decorate', true);
    for (const editor of vscode.window.visibleTextEditors) {
      const loc = s && on ? locate(s, editor.document.uri) : undefined;
      const cov = loc && loc.side === 'new' ? s!.meta.coverage?.get(loc.file.path) : undefined;
      editor.setDecorations(
        this.type,
        (cov?.uncovered ?? []).map((l) => ({
          range: new vscode.Range(l - 1, 0, l - 1, 0),
          hoverMessage: new vscode.MarkdownString(`🧪 **Not covered by tests.** This changed line didn't run in the pipeline's tests (${s!.meta.coverageSource}).`),
        })),
      );
    }
  }
}
