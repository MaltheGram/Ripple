import * as vscode from 'vscode';
import { analysisMarkdown } from '../ai/analysis';
import type { ReviewSession } from './session';

export const OVERVIEW_SCHEME = 'ripple-mr';
/** 0-based line of the "General discussion" heading, where general (non-line) threads are anchored. */
export const GENERAL_LINE = 3;

export function overviewUri(s: ReviewSession): vscode.Uri {
  return vscode.Uri.from({ scheme: OVERVIEW_SCHEME, path: `/!${s.entry.iid} overview.md`, query: String(s.entry.projectId) });
}

/** Read-only markdown "MR Overview": title, description and stats, with general discussions attached to it. */
export class OverviewProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private session?: ReviewSession;
  private sub?: vscode.Disposable;

  setSession(s: ReviewSession | undefined) {
    this.sub?.dispose();
    this.session = s;
    this.sub = s?.onDidChange(() => this.changed.fire(overviewUri(s)));
    if (s) this.changed.fire(overviewUri(s));
  }

  dispose() {
    this.sub?.dispose();
    this.changed.dispose();
  }

  provideTextDocumentContent(): string {
    const s = this.session;
    if (!s) return 'No merge request is open.';
    const { mr } = s;
    const st = s.stats();
    const lines = [
      `# !${mr.iid} ${mr.title}`,
      `${mr.author.name} · ${mr.source_branch} → ${mr.target_branch} · ${mr.state} · ${mr.web_url}`,
      '',
      '## General discussion (use the + in the gutter on this line to comment on the whole MR)',
      '',
      `Files: ${st.total} (${st.substantive} substantive, ${st.trivial} trivial) · viewed ${st.viewed}/${st.total}`,
      '',
      '## Description',
      '',
      mr.description?.trim() || '_No description._',
      '',
      s.ai ? analysisMarkdown(s.ai) : '## AI summary\n\n_Not run yet: use "✨ AI review" in the Review list._',
      '',
    ];
    return lines.join('\n');
  }
}
