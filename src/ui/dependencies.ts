import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewSession } from './session';

const DISMISSED_KEY = 'ripple.depsDismissed';

/**
 * Package install command for a checkout. `--ignore-scripts` (and `--ignore-pnpmfile` for pnpm) keep lifecycle
 * scripts and pnpm hooks from running. Package-manager config files can still run code, so installs are refused
 * when the MR touches any of them (see `blockingFiles`).
 */
export function installCommand(worktree: string): string | undefined {
  const has = (f: string) => existsSync(path.join(worktree, f));
  if (has('pnpm-lock.yaml')) return 'pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile';
  if (has('yarn.lock')) return 'yarn install --frozen-lockfile --ignore-scripts';
  if (has('package-lock.json')) return 'npm ci --ignore-scripts';
  if (has('package.json')) return 'npm install --ignore-scripts';
  return undefined;
}

/**
 * Files that make an install run code from the MR: manifests and lockfiles (they choose what gets installed and
 * may later be loaded by editor tooling), and package-manager config that can point at executables
 * (`.npmrc` git=, `.yarnrc` yarn-path, `.yarnrc.yml` yarnPath/plugins, `.pnpmfile.cjs`, `.yarn/**`).
 */
const INSTALL_SENSITIVE = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|\.npmrc|\.yarnrc(\.yml)?|\.pnpmfile\.cjs)$|(^|\/)\.yarn\//;

export function blockingFiles(s: ReviewSession): string[] {
  return s.files.flatMap((f) => [f.path, f.oldPath]).filter((p, i, all) => INSTALL_SENSITIVE.test(p) && all.indexOf(p) === i);
}

export function installDependencies(s: ReviewSession) {
  const cmd = installCommand(s.entry.worktree);
  if (!cmd) throw new Error('No package.json in the review checkout.');
  const blocked = blockingFiles(s);
  if (blocked.length) {
    throw new Error(
      `Not installing: this MR changes ${blocked.slice(0, 3).join(', ')}${blocked.length > 3 ? ' …' : ''}. ` +
        'Package manifests and package-manager config can run code during or after an install, and the MR is code under review.',
    );
  }
  const term = vscode.window.createTerminal({ name: `Ripple: install (${s.entry.projectPath})`, cwd: s.entry.worktree });
  term.show();
  term.sendText(cmd);
}

/** Once per project: offer to install dependencies so CMD+click works into node_modules. */
export async function offerDependencyInstall(context: vscode.ExtensionContext, s: ReviewSession) {
  if (vscode.workspace.getConfiguration('ripple').get<string>('installDependencies', 'ask') !== 'ask') return;
  const cmd = installCommand(s.entry.worktree);
  if (!cmd || existsSync(path.join(s.entry.worktree, 'node_modules')) || blockingFiles(s).length) return;
  const dismissed = context.globalState.get<string[]>(DISMISSED_KEY, []);
  if (dismissed.includes(s.entry.projectPath)) return;

  const choice = await vscode.window.showInformationMessage(
    `Install dependencies in the review checkout of ${s.entry.projectPath}? Go to definition into packages (node_modules) needs them. ` +
      `Runs "${cmd}" once (lifecycle scripts off); later MRs of this project reuse it.`,
    'Install',
    'Not Now',
    "Don't Ask for This Project",
  );
  if (choice === 'Install') installDependencies(s);
  if (choice === "Don't Ask for This Project") await context.globalState.update(DISMISSED_KEY, [...dismissed, s.entry.projectPath]);
}
