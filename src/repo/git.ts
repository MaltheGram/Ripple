import { execFile } from 'node:child_process';

export interface GitOptions {
  cwd: string;
  /** GitLab token for network operations. Passed via env config, never argv or `.git/config`. */
  token?: string;
  /** Resolve with stdout even on non-zero exit (e.g. `git diff --exit-code`). */
  allowFailure?: boolean;
  /** Written to stdin. */
  input?: string;
  /** Don't download missing objects in a partial clone (for existence checks). */
  noLazyFetch?: boolean;
}

const MAX_BUFFER = 512 * 1024 * 1024;

/** Host the GitLab token may be sent to (set from ripple.gitlab.baseUrl). */
let authBase = 'https://gitlab.com';

export function setGitAuthBase(baseUrl: string) {
  authBase = baseUrl.replace(/\/+$/, '');
}

export function git(args: string[], opts: GitOptions): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  // Tracing would print the auth header; LFS would fetch from wherever the MR's .lfsconfig points.
  for (const k of Object.keys(env)) if (k.startsWith('GIT_TRACE')) delete env[k];
  env.GIT_LFS_SKIP_SMUDGE = '1';
  let basic: string | undefined;
  if (opts.token) {
    basic = Buffer.from(`oauth2:${opts.token}`).toString('base64');
    env.GIT_CONFIG_COUNT = '1';
    // URL-scoped, so git (and helpers like git-lfs) only send the token to the GitLab host.
    env.GIT_CONFIG_KEY_0 = `http.${authBase}/.extraHeader`;
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
  }
  if (opts.noLazyFetch) env.GIT_NO_LAZY_FETCH = '1';
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotePath=false', ...args],
      { cwd: opts.cwd, env, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err && !opts.allowFailure) {
          reject(new Error(`git ${args[0]} failed: ${redact(stderr || err.message, opts.token, basic)}`));
        } else {
          resolve(stdout);
        }
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

function redact(text: string, ...secrets: (string | undefined)[]): string {
  return secrets.reduce<string>((t, sec) => (sec ? t.split(sec).join('***') : t), text);
}
