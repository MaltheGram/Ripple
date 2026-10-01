import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { label, routeIndexFor, type Trace, TraceBuilder, traceToMermaid } from '../analysis/trace';
import { log, timed } from '../log';
import { revealInDiff } from './diff';
import type { ReviewSession } from './session';

/** Webview with the trace of one function: who calls it and what it calls, across React, HTTP and services. */
export class TracePanel {
  private static current?: TracePanel;

  /** Trace the function at `uri:pos` (reusing the panel if it is open). */
  static async show(context: vscode.ExtensionContext, s: ReviewSession, uri: vscode.Uri, pos: vscode.Position) {
    if (!TracePanel.current) {
      const panel = vscode.window.createWebviewPanel('ripple.trace', 'Trace', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
      });
      TracePanel.current = new TracePanel(context, panel);
    }
    const p = TracePanel.current;
    p.panel.reveal(undefined, true);
    await p.load(s, uri, pos);
  }

  private session?: ReviewSession;
  private builder?: TraceBuilder;
  private trace?: Trace;
  private readonly ready: Promise<void>;
  private readonly disposables: vscode.Disposable[] = [];
  private sessionSub?: vscode.Disposable;
  private run = 0;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel,
  ) {
    const dir = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');
    panel.webview.html = html(panel.webview, dir);
    let markReady!: () => void;
    this.ready = new Promise((r) => (markReady = r));
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((msg) =>
        this.onMessage(msg, markReady).catch((e) => {
          log().error(`Trace: ${e instanceof Error ? e.message : e}`);
          void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
        }),
      ),
    );
  }

  private dispose() {
    TracePanel.current = undefined;
    this.sessionSub?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }

  private async load(s: ReviewSession, uri: vscode.Uri, pos: vscode.Position) {
    if (this.session !== s) {
      this.sessionSub?.dispose();
      this.sessionSub = s.onDidChange(() => void this.post({ type: 'viewed', viewedFiles: this.viewedFiles() }));
      this.session = s;
    }
    const run = ++this.run;
    await this.ready;
    await this.post({ type: 'loading', text: 'Finding callers and callees…' });
    try {
      const trace = await timed('trace', async () => {
        const builder = new TraceBuilder(s, await routeIndexFor(s));
        const t = await Promise.resolve(
          vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Tracing…' }, () => builder.start(uri, pos)),
        );
        if (run === this.run) this.builder = builder;
        return t;
      });
      if (run !== this.run) return;
      this.trace = trace;
      this.panel.title = `Trace · ${trace.title}`;
      await this.post({ type: 'trace', trace, viewedFiles: this.viewedFiles() });
    } catch (e) {
      await this.post({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  }

  private async onMessage(msg: { type: string; id?: string; dir?: 'up' | 'down'; file?: string; viewed?: boolean; ids?: string[] }, markReady: () => void) {
    const s = this.session;
    if (msg.type === 'ready') return markReady();
    if (!s) return;
    const node = msg.id ? this.trace?.nodes.find((n) => n.id === msg.id) : undefined;
    switch (msg.type) {
      case 'open': {
        if (!node || node.external) return;
        const f = s.fileByPath(node.file);
        if (f && f.change !== 'deleted' && node.changed) return revealInDiff(s, f, node.line + 1);
        const pos = new vscode.Position(node.line, 0);
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(s.entry.worktree, node.file)), {
          selection: new vscode.Range(pos, pos),
          viewColumn: vscode.ViewColumn.One,
        });
        return;
      }
      case 'expand':
        if (!this.builder || !msg.id || !msg.dir) return;
        this.trace = await this.builder.expand(msg.id, msg.dir);
        await this.post({ type: 'trace', trace: this.trace, viewedFiles: this.viewedFiles(), keepView: true });
        return;
      case 'retrace':
        if (!node || node.external) return;
        return this.load(s, vscode.Uri.file(path.join(s.entry.worktree, node.file)), new vscode.Position(node.line, 0));
      case 'markViewed': {
        const f = msg.file ? s.fileByPath(msg.file) : undefined;
        if (f) await s.setViewed([f], !!msg.viewed);
        return;
      }
      case 'mermaid': {
        if (!this.trace) return;
        const keep = new Set(msg.ids ?? this.trace.nodes.map((n) => n.id));
        const t = { ...this.trace, nodes: this.trace.nodes.filter((n) => keep.has(n.id)), edges: this.trace.edges.filter((e) => keep.has(e.from) && keep.has(e.to)) };
        await vscode.env.clipboard.writeText('```mermaid\n' + traceToMermaid(t) + '\n```\n');
        const target = this.trace.nodes.find((n) => n.id === this.trace!.targetId);
        void vscode.window.showInformationMessage(`Trace of ${target ? label(target) : 'function'} copied as Mermaid.`);
        return;
      }
    }
  }

  private viewedFiles(): string[] {
    const s = this.session;
    return s ? s.files.filter((f) => s.isViewed(f)).map((f) => f.path) : [];
  }

  private post(msg: unknown) {
    return this.panel.webview.postMessage(msg);
  }
}

function html(webview: vscode.Webview, dir: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  return readFileSync(vscode.Uri.joinPath(dir, 'trace.html').fsPath, 'utf8')
    .replace('{{CSP}}', `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`)
    .replace('{{NONCE}}', nonce)
    .replace('{{SCRIPT}}', webview.asWebviewUri(vscode.Uri.joinPath(dir, 'trace.js')).toString());
}
