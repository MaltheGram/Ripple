import * as vscode from 'vscode';
import { TracePanel } from '../ui/tracePanel';
import type { App } from '../app';

/** Code understanding: trace a function, cross-service impact. */
export function registerCodeCommands(app: App) {
  const { crossService } = app;
  // Trace one function: from the editor cursor, a CodeLens ({ uri, line, character }) or an Impact view item.
  app.command('ripple.trace', async (at?: { uri?: string; line?: number; character?: number; entry?: { symbol?: { uri: vscode.Uri; selection: vscode.Range } } }) => {
    const s = app.need();
    let uri: vscode.Uri;
    let pos: vscode.Position;
    if (at?.entry?.symbol) {
      uri = at.entry.symbol.uri;
      pos = at.entry.symbol.selection.start;
    } else if (at?.uri && typeof at.line === 'number') {
      uri = vscode.Uri.parse(at.uri);
      pos = new vscode.Position(at.line, at.character ?? 0);
    } else {
      const editor = vscode.window.activeTextEditor;
      if (!editor) throw new Error('Put the cursor in a function (right side of a diff or any file of the MR checkout).');
      uri = editor.document.uri;
      pos = editor.selection.active;
    }
    if (uri.scheme !== 'file') throw new Error('Trace works on the new version: use the right side of the diff.');
    await TracePanel.show(app.context, s, uri, pos);
  });
  app.command('ripple.crossService.scan', () => crossService.scan({ force: true }));
  app.command('ripple.crossService.openContract', (node) => crossService.openContract(node));
  app.command('ripple.crossService.openUsage', (node) => crossService.openUsage(node));
  app.command('ripple.crossService.comment', (node) => crossService.comment(node));
}
