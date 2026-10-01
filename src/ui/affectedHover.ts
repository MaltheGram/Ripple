import * as path from 'node:path';
import * as vscode from 'vscode';
import { changedDependencies, identifiers } from '../core/deps';
import type { Hunk } from '../core/types';
import type { ReviewSession } from './session';

const CACHE_SIZE = 200;

/**
 * Hover on a name in untouched code whose definition this MR changed:
 * "Affected by this MR: `sum3` changed in src/app.service.ts:15-18", with links to the change and to Explain.
 * Language server only (no AI); silent unless the definition really changed.
 */
export class AffectedHover implements vscode.HoverProvider {
  private readonly cache = new Map<string, vscode.Hover | null>();

  constructor(private readonly session: () => ReviewSession | undefined) {}

  async provideHover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
    const s = this.session();
    if (!s || !vscode.workspace.getConfiguration('ripple').get('hoverHints', true)) return undefined;
    const root = s.entry.worktree + path.sep;
    if (doc.uri.scheme !== 'file' || !doc.uri.fsPath.startsWith(root)) return undefined;
    const word = doc.getWordRangeAtPosition(pos, /[A-Za-z_$][\w$]*/);
    if (!word || !identifiers(doc.getText(word)).length) return undefined;

    const rel = path.relative(s.entry.worktree, doc.uri.fsPath).split(path.sep).join('/');
    // Changed lines are already visible as changes; the hint is for code the MR did not touch.
    const own = s.files.find((f) => f.path === rel);
    if (own?.hunks.some((h) => h.newLines > 0 && pos.line + 1 >= h.newStart && pos.line + 1 < h.newStart + h.newLines)) return undefined;

    const key = `${s.refs.head_sha}:${doc.uri.fsPath}:${doc.version}:${word.start.line}:${word.start.character}`;
    if (this.cache.has(key)) return this.cache.get(key) ?? undefined;

    const locs = (await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', doc.uri, pos)) ?? [];
    const name = doc.getText(word);
    const defs = locs.flatMap((loc) => {
      const uri = 'targetUri' in loc ? loc.targetUri : loc.uri;
      const r = 'targetRange' in loc ? loc.targetRange : loc.range;
      if (uri.scheme !== 'file' || !uri.fsPath.startsWith(root) || uri.fsPath.includes(`${path.sep}node_modules${path.sep}`)) return [];
      // Hovering the definition itself.
      if (uri.fsPath === doc.uri.fsPath && r.contains(pos)) return [];
      return [{ name, path: path.relative(s.entry.worktree, uri.fsPath).split(path.sep).join('/'), startLine: r.start.line + 1, endLine: r.end.line + 1 }];
    });
    const hunks = new Map<string, Hunk[]>(s.files.filter((f) => f.change !== 'deleted').map((f) => [f.path, f.hunks]));
    const changed = changedDependencies(defs, hunks);

    let hover: vscode.Hover | null = null;
    if (changed.length) {
      const d = changed[0];
      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = { enabledCommands: ['ripple.revealChange', 'ripple.ai.explain'] };
      const reveal = encodeURIComponent(JSON.stringify([d.path, d.hunks[0].newStart]));
      const explain = encodeURIComponent(JSON.stringify([{ line: pos.line }]));
      md.appendMarkdown(`$(git-pull-request) **Affected by this MR**: \`${code(d.name)}\` changed in \`${code(d.path)}:${d.startLine}-${d.endLine}\`\n\n`);
      md.appendMarkdown(`[Open the change](command:ripple.revealChange?${reveal}) · [Explain how this is affected (Alt+E)](command:ripple.ai.explain?${explain})`);
      hover = new vscode.Hover(md, word);
    }
    if (this.cache.size > CACHE_SIZE) this.cache.clear();
    this.cache.set(key, hover);
    return hover ?? undefined;
  }
}

/** Text inside inline code: drop backticks and brackets so a crafted file name can't break out into a link. */
function code(t: string): string {
  return t.replace(/[`[\]()<>]/g, '');
}
