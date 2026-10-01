import * as vscode from 'vscode';
import { setTestToken } from './auth/gitlabAuth';
import type { CrossServiceResult } from './analysis/crossService';
import { App, configuredBaseUrl } from './app';
import { setGitAuthBase } from './repo/git';
import { registerAccountCommands } from './commands/account';
import { registerAiCommands } from './commands/ai';
import { registerCodeCommands } from './commands/code';
import { registerCommentCommands } from './commands/comments';
import { registerMergeRequestCommands } from './commands/mergeRequests';
import { registerReviewCommands } from './commands/review';
import type { ReviewSession } from './ui/session';
import { AffectedHover } from './ui/affectedHover';
import { HistoryHover } from './ui/historyHover';
import { installDependencies, offerDependencyInstall } from './ui/dependencies';
import { GIT_SCHEME, GitContentProvider } from './ui/diff';
import { EXPLAIN_DOC_SCHEME } from './ui/explainView';
import { OVERVIEW_SCHEME } from './ui/overview';
import { checkForUpdates } from './update';

/** Only returned when VS Code runs the extension in test mode (see test/e2e). */
export interface TestApi {
  useToken(token: string): void;
  session(): ReviewSession | undefined;
  crossService(): CrossServiceResult | undefined;
}

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  const app = new App(context);
  setGitAuthBase(configuredBaseUrl());
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ripple.gitlab.baseUrl')) setGitAuthBase(configuredBaseUrl());
    }),
  );

  app.push(
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, new GitContentProvider()),
    vscode.workspace.registerTextDocumentContentProvider(OVERVIEW_SCHEME, app.overview),
    vscode.workspace.registerTextDocumentContentProvider(EXPLAIN_DOC_SCHEME, app.explainView),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, app.traceLens),
    vscode.languages.registerHoverProvider({ scheme: 'file' }, new AffectedHover(() => app.session)),
    vscode.languages.registerHoverProvider([{ scheme: 'file' }, { scheme: GIT_SCHEME }], new HistoryHover(() => app.session)),
  );
  registerAccountCommands(app);
  registerMergeRequestCommands(app);
  registerReviewCommands(app);
  registerCommentCommands(app);
  registerAiCommands(app);
  registerCodeCommands(app);
  app.command('ripple.installDependencies', () => installDependencies(app.need()));
  app.command('ripple.gettingStarted', () =>
    vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#gettingStarted`, false),
  );

  app.command('ripple.checkForUpdates', () => checkForUpdates(context, true));

  void vscode.commands.executeCommand('setContext', 'ripple.active', false);

  if (context.extensionMode === vscode.ExtensionMode.Test) {
    // No prompts in tests.
    return { useToken: setTestToken, session: () => app.session, crossService: () => app.crossService.current };
  }

  // First run: show the walkthrough once.
  if (!context.globalState.get('ripple.walkthroughShown')) {
    void context.globalState.update('ripple.walkthroughShown', true);
    void vscode.commands.executeCommand('ripple.gettingStarted');
  }

  if (context.extensionMode === vscode.ExtensionMode.Production) setTimeout(() => void checkForUpdates(context), 10_000);

  app.onSessionChange((s) => {
    if (s) setTimeout(() => void offerDependencyInstall(context, s), 4000);
  });

  // Reopen the MR this window was reviewing.
  const entry = app.store.activeReview();
  if (entry) {
    app.start(entry).catch(async (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      const action = await vscode.window.showErrorMessage(`Ripple: could not load !${entry.iid}: ${msg}`, 'Sign in', 'Retry');
      if (action === 'Sign in') void vscode.commands.executeCommand('ripple.signIn');
      if (action === 'Retry') void app.start(entry);
    });
  }
}

export function deactivate() {}
