import { writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { isNewerVersion } from './core/version';
import { log } from './log';

const LAST_CHECK_KEY = 'ripple.update.lastCheck';
const SKIPPED_KEY = 'ripple.update.skipped';
const DAY = 24 * 60 * 60 * 1000;
const MAX_VSIX_BYTES = 50 * 1024 * 1024;
/** Release assets are served from github.com and redirect to GitHub's download hosts. */
const ASSET_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

interface Release {
  tag_name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string; size: number }[];
}

/** `owner/repo` from package.json's repository URL. */
function repoOf(context: vscode.ExtensionContext): string | undefined {
  const url: string | undefined = context.extension.packageJSON.repository?.url;
  return url?.match(/github\.com[/:]([^/]+\/[^/.]+)/)?.[1];
}

/**
 * Look for a newer GitHub release and offer to install it. Automatic checks run at most once a day
 * and stay quiet on errors; the command (`manual`) always checks and reports the result.
 */
export async function checkForUpdates(context: vscode.ExtensionContext, manual = false): Promise<void> {
  if (!manual) {
    if (!vscode.workspace.getConfiguration('ripple').get('checkForUpdates', true)) return;
    const last = context.globalState.get<number>(LAST_CHECK_KEY, 0);
    if (Date.now() - last < DAY) return;
  }
  const repo = repoOf(context);
  if (!repo) return;
  void context.globalState.update(LAST_CHECK_KEY, Date.now());

  let release: Release;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ripple-vscode' },
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    release = (await res.json()) as Release;
  } catch (e) {
    log().warn(`update check: ${e instanceof Error ? e.message : e}`);
    if (manual) void vscode.window.showWarningMessage(`Ripple: could not check for updates (${e instanceof Error ? e.message : e}).`);
    return;
  }

  const current: string = context.extension.packageJSON.version;
  const latest = release.tag_name;
  if (release.draft || release.prerelease || !isNewerVersion(latest, current)) {
    if (manual) void vscode.window.showInformationMessage(`Ripple ${current} is the latest version.`);
    return;
  }
  if (!manual && context.globalState.get<string>(SKIPPED_KEY) === latest) return;

  const asset = release.assets.find((a) => a.name.endsWith('.vsix'));
  const pick = await vscode.window.showInformationMessage(
    `Ripple ${latest} is available (you have ${current}).`,
    ...(asset ? ['Update'] : []),
    'Release Notes',
    'Skip This Version',
  );
  if (pick === 'Release Notes') void vscode.env.openExternal(vscode.Uri.parse(release.html_url));
  if (pick === 'Skip This Version') void context.globalState.update(SKIPPED_KEY, latest);
  if (pick === 'Update' && asset) await install(context, asset.browser_download_url, asset.name);
}

async function install(context: vscode.ExtensionContext, url: string, name: string): Promise<void> {
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Ripple: downloading ${name}` }, async () => {
    if (!ASSET_HOSTS.has(new URL(url).hostname)) throw new Error(`unexpected download host in ${url}`);
    const res = await fetch(url, { headers: { 'User-Agent': 'ripple-vscode' } });
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    if (!ASSET_HOSTS.has(new URL(res.url).hostname)) throw new Error(`unexpected download host in ${res.url}`);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_VSIX_BYTES) throw new Error('download too large');
    await vscode.workspace.fs.createDirectory(context.globalStorageUri);
    const file = vscode.Uri.joinPath(context.globalStorageUri, 'ripple-update.vsix');
    await writeFile(file.fsPath, data);
    await vscode.commands.executeCommand('workbench.extensions.installExtension', file);
  });
  const reload = await vscode.window.showInformationMessage('Ripple was updated. Reload the window to use the new version.', 'Reload');
  if (reload) void vscode.commands.executeCommand('workbench.action.reloadWindow');
}
