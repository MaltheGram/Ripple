import * as vscode from 'vscode';
import { AUTH_PROVIDER_ID, SCOPES } from '../auth/gitlabAuth';
import type { App } from '../app';

/** GitLab sign-in and sign-out. */
export function registerAccountCommands(app: App) {
  app.command('ripple.signIn', async () => {
    await vscode.authentication.getSession(AUTH_PROVIDER_ID, SCOPES, { createIfNone: true });
    app.mrList.refresh();
    const entry = app.store.activeReview();
    if (entry && !app.session) await app.start(entry);
  });
  app.command('ripple.signOut', () => app.auth.removeSession());
  app.push(app.auth.onDidChangeSessions(() => app.mrList.refresh()), vscode.window.registerUriHandler(app.auth));
}
