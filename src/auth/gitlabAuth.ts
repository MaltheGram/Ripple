import { createHash, randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export const AUTH_PROVIDER_ID = 'ripple-gitlab';
export const SCOPES = ['api', 'read_user'];

const SECRET_KEY = 'ripple.gitlab.session';
const CALLBACK_PATH = '/auth-callback';
const REFRESH_MARGIN_MS = 5 * 60_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

interface StoredSession {
  id: string;
  kind: 'oauth' | 'pat';
  baseUrl: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  account: { id: string; label: string };
  scopes: string[];
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  created_at?: number;
}

/**
 * GitLab sign-in for VS Code's Accounts menu.
 * OAuth 2 authorization code + PKCE (public client, so no secret ships in the extension),
 * with a Personal Access Token fallback when no OAuth app is configured.
 */
export class GitLabAuthProvider implements vscode.AuthenticationProvider, vscode.UriHandler, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  readonly onDidChangeSessions = this.changes.event;

  private readonly pending = new Map<string, (params: URLSearchParams) => void>();
  private refreshing?: Promise<StoredSession | undefined>;
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables = [
      vscode.authentication.registerAuthenticationProvider(AUTH_PROVIDER_ID, 'GitLab (Ripple)', this),
      this.changes,
    ];
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }

  async getSessions(): Promise<vscode.AuthenticationSession[]> {
    const stored = await this.freshSession();
    return stored ? [toSession(stored)] : [];
  }

  async createSession(): Promise<vscode.AuthenticationSession> {
    const { baseUrl, clientId } = config();
    const stored = clientId ? await this.oauthLogin(baseUrl, clientId) : await this.patLogin(baseUrl);
    await this.save(stored);
    const session = toSession(stored);
    this.changes.fire({ added: [session], removed: [], changed: [] });
    return session;
  }

  async removeSession(): Promise<void> {
    const stored = await this.load();
    if (!stored) return;
    await this.context.secrets.delete(SECRET_KEY);
    this.changes.fire({ added: [], removed: [toSession(stored)], changed: [] });
    if (stored.kind === 'oauth') void this.revoke(stored);
  }

  handleUri(uri: vscode.Uri): void {
    if (uri.path !== CALLBACK_PATH) return;
    const params = new URLSearchParams(uri.query);
    const state = params.get('state');
    const resolve = state ? this.pending.get(state) : undefined;
    if (resolve) resolve(params);
  }

  private async oauthLogin(baseUrl: string, clientId: string): Promise<StoredSession> {
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = base64url(randomBytes(16));
    const redirectUri = this.redirectUri();

    const authorize = new URL(`${baseUrl}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state,
      scope: SCOPES.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();

    const params = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Signing in to GitLab… (complete in your browser)', cancellable: true },
      (_, cancel) =>
        new Promise<URLSearchParams>((resolve, reject) => {
          const done = () => {
            clearTimeout(timer);
            this.pending.delete(state);
          };
          const timer = setTimeout(() => {
            done();
            reject(new Error('GitLab sign-in timed out.'));
          }, LOGIN_TIMEOUT_MS);
          cancel.onCancellationRequested(() => {
            done();
            reject(new Error('GitLab sign-in cancelled.'));
          });
          this.pending.set(state, (p) => {
            done();
            resolve(p);
          });
          void vscode.env.openExternal(vscode.Uri.parse(authorize.toString(), true));
        }),
    );

    const error = params.get('error');
    if (error) throw new Error(`GitLab sign-in failed: ${params.get('error_description') ?? error}`);
    const code = params.get('code');
    if (!code) throw new Error('GitLab sign-in failed: no authorization code returned.');

    const token = await tokenRequest(baseUrl, {
      client_id: clientId,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    return this.toStored('oauth', baseUrl, token);
  }

  private async patLogin(baseUrl: string): Promise<StoredSession> {
    const createUrl = `${baseUrl}/-/user_settings/personal_access_tokens?name=Ripple&scopes=api`;
    const choice = await vscode.window.showInformationMessage(
      'Sign in to GitLab with a Personal Access Token',
      {
        modal: true,
        detail:
          'No OAuth app is configured yet (setting ripple.gitlab.clientId), so Ripple uses a token.\n\n' +
          '1. Create a token with the "api" scope in GitLab.\n2. Paste it in the box at the top of the window.',
      },
      'Create Token in Browser',
      'I Have a Token',
    );
    if (!choice) throw new Error('GitLab sign-in cancelled.');
    if (choice === 'Create Token in Browser') await vscode.env.openExternal(vscode.Uri.parse(createUrl, true));

    const token = await vscode.window.showInputBox({
      title: 'GitLab Personal Access Token',
      prompt: `Paste a token with the "api" scope (${baseUrl})`,
      placeHolder: 'glpat-…',
      password: true,
      ignoreFocusOut: true,
    });
    if (!token) throw new Error('GitLab sign-in cancelled.');
    return this.toStored('pat', baseUrl, { access_token: token.trim() });
  }

  private async toStored(kind: StoredSession['kind'], baseUrl: string, token: TokenResponse): Promise<StoredSession> {
    const res = await fetch(`${baseUrl}/api/v4/user`, { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!res.ok) throw new Error(`GitLab rejected the token (${res.status}).`);
    const user = (await res.json()) as { id: number; username: string; name: string };
    return {
      id: `${baseUrl}#${user.id}`,
      kind,
      baseUrl,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: expiresAt(token),
      account: { id: String(user.id), label: `${user.name} (@${user.username})` },
      scopes: SCOPES,
    };
  }

  /** Returns the stored session, refreshing the OAuth token first if it is about to expire. */
  private async freshSession(): Promise<StoredSession | undefined> {
    const stored = await this.load();
    if (!stored || stored.kind !== 'oauth' || !stored.expiresAt || stored.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
      return stored;
    }
    this.refreshing ??= this.refresh(stored).finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async refresh(stored: StoredSession): Promise<StoredSession | undefined> {
    const { clientId } = config();
    try {
      if (!stored.refreshToken || !clientId) throw new Error('no refresh token');
      const token = await tokenRequest(stored.baseUrl, {
        client_id: clientId,
        refresh_token: stored.refreshToken,
        grant_type: 'refresh_token',
        redirect_uri: this.redirectUri(),
      });
      const next: StoredSession = {
        ...stored,
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? stored.refreshToken,
        expiresAt: expiresAt(token),
      };
      await this.save(next);
      this.changes.fire({ added: [], removed: [], changed: [toSession(next)] });
      return next;
    } catch {
      await this.context.secrets.delete(SECRET_KEY);
      this.changes.fire({ added: [], removed: [toSession(stored)], changed: [] });
      return undefined;
    }
  }

  private async revoke(stored: StoredSession) {
    const { clientId } = config();
    if (!clientId) return;
    await fetch(`${stored.baseUrl}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, token: stored.accessToken }),
    }).catch(() => undefined);
  }

  private redirectUri(): string {
    return `${vscode.env.uriScheme}://${this.context.extension.id}${CALLBACK_PATH}`;
  }

  private async load(): Promise<StoredSession | undefined> {
    const raw = await this.context.secrets.get(SECRET_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : undefined;
  }

  private save(s: StoredSession) {
    return this.context.secrets.store(SECRET_KEY, JSON.stringify(s));
  }
}

function config() {
  const c = vscode.workspace.getConfiguration('ripple.gitlab');
  return {
    baseUrl: c.get<string>('baseUrl', 'https://gitlab.com').replace(/\/+$/, ''),
    clientId: c.get<string>('clientId', '').trim(),
  };
}

async function tokenRequest(baseUrl: string, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  if (!res.ok) {
    const text = await res.text();
    if (text.includes('invalid_client')) {
      throw new Error(
        'GitLab rejected the OAuth app (invalid_client). In GitLab, edit the application and untick "Confidential" ' +
          '(Ripple is a public client without a secret), and check that ripple.gitlab.clientId is its Application ID.',
      );
    }
    throw new Error(`GitLab token request failed (${res.status}): ${text}`);
  }
  return (await res.json()) as TokenResponse;
}

function expiresAt(t: TokenResponse): number | undefined {
  if (!t.expires_in) return undefined;
  const created = t.created_at ? t.created_at * 1000 : Date.now();
  return created + t.expires_in * 1000;
}

function toSession(s: StoredSession): vscode.AuthenticationSession {
  return { id: s.id, accessToken: s.accessToken, account: s.account, scopes: s.scopes };
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

let testToken: string | undefined;

/** e2e tests only: bypass VS Code's account consent dialog, which tests cannot answer. */
export function setTestToken(token: string | undefined) {
  testToken = token;
}

/** Get a GitLab token for API/git calls, prompting sign-in when `interactive`. */
export async function getGitLabToken(interactive: boolean): Promise<string> {
  if (testToken) return testToken;
  const session = await vscode.authentication.getSession(AUTH_PROVIDER_ID, SCOPES, interactive ? { createIfNone: true } : { silent: true });
  if (!session) throw new Error('Not signed in to GitLab. Run "Ripple: Sign in to GitLab".');
  return session.accessToken;
}
