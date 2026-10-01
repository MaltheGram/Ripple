import * as vscode from 'vscode';
import type { GlMergeRequest } from '../gitlab/types';
import { locate } from './diff';
import type { ReviewSession } from './session';

interface History {
  sha: string;
  author: string;
  date: string;
  message: string;
  mr?: GlMergeRequest;
}

/**
 * Hover on a changed line (new side) or any old-side line: when the code it replaces last changed, by whom and in
 * which MR. Uses GitLab's blame API (the review checkout is a partial clone, so a local blame would download history).
 */
export class HistoryHover implements vscode.HoverProvider {
  private readonly cache = new Map<string, Promise<History | undefined>>();

  constructor(private readonly session: () => ReviewSession | undefined) {}

  async provideHover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
    const s = this.session();
    if (!s || !vscode.workspace.getConfiguration('ripple').get('historyHover', true)) return undefined;
    const loc = locate(s, doc.uri);
    if (!loc || loc.file.change === 'added') return undefined;
    const line = pos.line + 1;

    let range: [number, number] | undefined;
    if (loc.side === 'old') range = [line, line];
    else {
      // Only changed lines: the history of the old lines they replace. New lines without old ones have no history.
      const h = loc.file.hunks.find((x) => x.newLines > 0 && line >= x.newStart && line < x.newStart + x.newLines);
      if (!h || h.oldLines === 0) return undefined;
      range = [h.oldStart, h.oldStart + h.oldLines - 1];
    }

    const key = `${s.refs.base_sha}:${loc.file.oldPath}:${range[0]}-${range[1]}`;
    let p = this.cache.get(key);
    if (!p) {
      p = this.lookup(s, loc.file.oldPath, range).catch(() => undefined);
      this.cache.set(key, p);
    }
    const h = await p;
    if (!h) return undefined;
    const md = new vscode.MarkdownString(undefined, true);
    const mr = h.mr ? ` in [!${h.mr.iid} ${escapeMd(h.mr.title)}](${h.mr.web_url})` : '';
    md.appendMarkdown(
      `$(history) **Previously**${loc.side === 'new' ? ' (the code this replaces)' : ''}: last changed by ${escapeMd(h.author)}, ${ago(h.date)}${mr}  \n` +
        `\`${h.sha.slice(0, 8)}\` ${escapeMd(h.message.split('\n')[0].slice(0, 100))}`,
    );
    return new vscode.Hover(md);
  }

  private async lookup(s: ReviewSession, path: string, [start, end]: [number, number]): Promise<History | undefined> {
    const ranges = await s.client.blame(s.entry.projectId, path, s.refs.base_sha, start, end);
    // The most recent change among the lines.
    const c = ranges.map((r) => r.commit).sort((a, b) => Date.parse(b.authored_date) - Date.parse(a.authored_date))[0];
    if (!c) return undefined;
    const mrs = await s.client.commitMergeRequests(s.entry.projectId, c.id).catch(() => []);
    const mr = mrs.find((m) => m.state === 'merged') ?? mrs[0];
    return { sha: c.id, author: c.author_name, date: c.authored_date, message: c.message, mr };
  }
}

function ago(iso: string): string {
  const days = Math.round((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 730) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

function escapeMd(t: string): string {
  return t.replace(/[\\`*_{}[\]()#+!|<>]/g, '\\$&');
}
