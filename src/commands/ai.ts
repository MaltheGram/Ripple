import * as vscode from 'vscode';
import { explainSelection, explanationToDraft } from '../ai/explain';
import { editOptions, postSummary, runAnalysis, suggestComments } from '../ai/features';
import type { AiOptions } from '../ai/options';
import type { App } from '../app';

/** AI review, options, suggestions, and the Explain list. */
export function registerAiCommands(app: App) {
  const { context, explainView } = app;
  // `preset` lets tests run without the options menu.
  app.command('ripple.ai.analyze', (preset?: AiOptions) => runAnalysis(app.need(), context, preset?.model ? preset : undefined));
  app.command('ripple.ai.options', () => editOptions(context));
  app.command('ripple.ai.postSummary', () => postSummary(app.need()));
  app.command('ripple.ai.suggestComments', () => suggestComments(app.need(), context, app.comments));

  app.command('ripple.ai.explain', async (at?: { line?: number }) => {
    const s = app.need();
    // From the hover link: explain the line that was hovered.
    const editor = vscode.window.activeTextEditor;
    if (editor && typeof at?.line === 'number') editor.selection = new vscode.Selection(at.line, 0, at.line, 0);
    await explainView.show(await explainSelection(s, context));
  });
  app.command('ripple.ai.explainFile', async () => explainView.show(await explainSelection(app.need(), context, { wholeFile: true })));
  app.command('ripple.ai.explainAsk', async (question?: string) => (question ? explainView.ask(question) : explainView.askAbout()));
  app.command('ripple.ai.explainToComment', async () => {
    const r = explainView.shown;
    if (!r) throw new Error('Explain some code first (Alt+E).');
    void vscode.window.showInformationMessage(await explanationToDraft(app.need(), r, 'all'));
  });
  app.command('ripple.explain.open', (node) => explainView.openNode(node));
  app.command('ripple.explain.ask', (node) => explainView.askAbout(node));
  app.command('ripple.explain.comment', (node) => explainView.comment(node));
  app.command('ripple.explain.remove', (node) => explainView.remove(node));
  app.command('ripple.explain.clear', () => explainView.remove());
}
