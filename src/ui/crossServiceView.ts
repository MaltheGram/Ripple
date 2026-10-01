import * as vscode from 'vscode';
import { type ContractImpact, type CrossServiceResult, IMPACT_LABEL, impactComment, scanCrossService, type Usage } from '../analysis/crossService';
import type { Contract } from '../core/contracts';
import { positionForLines } from './comments';
import { revealInDiff } from './diff';
import type { ReviewSession } from './session';

type Node =
  | { kind: 'contract'; item: ContractImpact }
  | { kind: 'project'; item: ContractImpact; project: string; usages: Usage[] }
  | { kind: 'usage'; usage: Usage }
  | { kind: 'message'; text: string };

const KIND_ICON: Record<Contract['kind'], string> = { type: 'symbol-interface', route: 'globe', event: 'broadcast' };
const IMPACT_COLOR: Record<Contract['impact'], string> = {
  breaking: 'list.errorForeground',
  removed: 'list.errorForeground',
  modified: 'list.warningForeground',
  additive: 'gitDecoration.addedResourceForeground',
  added: 'gitDecoration.addedResourceForeground',
};

/** "Cross-service" sidebar: contracts this MR changes (types, routes, events) and where other repos use them. */
export class CrossServiceView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: vscode.TreeView<Node>;
  private session?: ReviewSession;
  private result?: CrossServiceResult;
  private running?: Promise<CrossServiceResult>;

  constructor() {
    this.view = vscode.window.createTreeView('ripple.crossService', { treeDataProvider: this });
  }

  dispose() {
    this.view.dispose();
    this.changed.dispose();
  }

  setSession(s: ReviewSession | undefined) {
    if (s === this.session) return;
    this.session = s;
    this.result = undefined;
    this.refresh();
  }

  /** Scan once per MR version; later calls reuse the result (or join a running scan) unless `force`. */
  async scan({ force = false } = {}): Promise<CrossServiceResult> {
    const s = this.need();
    if (!force && this.result?.headSha === s.refs.head_sha) return this.result;
    this.running ??= Promise.resolve(
      vscode.window.withProgress(
        { location: { viewId: 'ripple.crossService' }, title: 'Searching other repositories…', cancellable: true },
        (progress, cancel) => scanCrossService(s, { cancel, progress: (message) => progress.report({ message }) }),
      ),
    ).finally(() => (this.running = undefined));
    this.result = await this.running;
    this.refresh();
    const withUsages = this.result.items.filter((i) => i.usages.length).length;
    void vscode.window.showInformationMessage(
      this.result.items.length
        ? `Cross-service: ${this.result.items.length} changed contract(s), ${withUsages} used elsewhere in "${this.result.group}".` +
            (this.result.partial ? ' GitLab rate-limited the search; scan again in a minute for the rest.' : '')
        : 'Cross-service: this MR changes no shared types, routes or events.',
    );
    return this.result;
  }

  get current(): CrossServiceResult | undefined {
    return this.result;
  }

  async openContract(node: Node) {
    if (node.kind !== 'contract') return;
    const s = this.need();
    const c = node.item.contract;
    const f = s.fileByPath(c.path);
    if (f && c.side === 'new') return revealInDiff(s, f, c.line);
    if (f) return vscode.commands.executeCommand('ripple.openFile', f.path);
  }

  openUsage(node: Node) {
    if (node.kind === 'usage' && node.usage.url) return vscode.env.openExternal(vscode.Uri.parse(node.usage.url));
  }

  /** Draft comment on the contract's declaration listing where it is used. */
  async comment(node?: Node) {
    const s = this.need();
    const item = node?.kind === 'contract' ? node.item : undefined;
    if (!item) throw new Error('Pick a contract in the Cross-service list.');
    if (!item.usages.length) throw new Error('No usages found outside this MR, so there is nothing to point out.');
    const c = item.contract;
    const f = s.fileByPath(c.path);
    if (!f) throw new Error(`${c.path} is not part of this MR version.`);
    await s.client.createDraft(s.entry.projectId, s.entry.iid, { note: impactComment(item), position: positionForLines(s, f, c.side, c.line, c.line) });
    await s.reloadComments();
    void vscode.window.showInformationMessage(`Draft comment added on ${c.name}.`);
  }

  getChildren(node?: Node): Node[] {
    if (!this.session || !this.result) return [];
    if (!node) {
      if (!this.result.items.length) return [{ kind: 'message', text: 'No shared types, routes or events changed in this MR.' }];
      return this.result.items.map((item) => ({ kind: 'contract', item }));
    }
    if (node.kind === 'contract') {
      const { item } = node;
      if (item.error) return [{ kind: 'message', text: item.error }];
      if (item.skipped) return [{ kind: 'message', text: 'Not searched (query budget or rate limit). Scan again later.' }];
      if (!item.usages.length) return [{ kind: 'message', text: 'No usages found outside this MR.' }];
      const byProject = new Map<string, Usage[]>();
      for (const u of item.usages) {
        if (!byProject.has(u.projectPath)) byProject.set(u.projectPath, []);
        byProject.get(u.projectPath)!.push(u);
      }
      return [...byProject].map(([project, usages]) => ({ kind: 'project', item, project, usages }));
    }
    if (node.kind === 'project') return node.usages.map((usage) => ({ kind: 'usage', usage }));
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'message') return new vscode.TreeItem(node.text);
    if (node.kind === 'contract') {
      const { contract: c, usages, skipped, error } = node.item;
      const projects = new Set(usages.map((u) => u.projectPath)).size;
      const item = new vscode.TreeItem(c.name, usages.length || skipped || error ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
      item.id = `contract:${c.kind}:${c.name}`;
      item.description = [
        IMPACT_LABEL[c.impact],
        skipped ? 'not searched' : error ? 'search failed' : usages.length ? `${usages.length} usage${usages.length === 1 ? '' : 's'} in ${projects} project${projects === 1 ? '' : 's'}` : 'no usages elsewhere',
      ].join(' · ');
      item.iconPath = new vscode.ThemeIcon(KIND_ICON[c.kind], new vscode.ThemeColor(IMPACT_COLOR[c.impact]));
      item.tooltip = new vscode.MarkdownString(`**${c.name}** (${c.kind})\n\n${IMPACT_LABEL[c.impact]}: ${c.detail}\n\nDeclared in \`${c.path}:${c.line}\``);
      item.contextValue = usages.length ? 'contractUsed' : 'contract';
      item.command = { command: 'ripple.crossService.openContract', title: 'Open declaration', arguments: [node] };
      return item;
    }
    if (node.kind === 'project') {
      const item = new vscode.TreeItem(node.project, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `contract:${node.item.contract.name}:project:${node.project}`;
      item.description = `${node.usages.length}${node.usages[0].sameProject ? ' · this repo (default branch)' : ''}`;
      item.iconPath = new vscode.ThemeIcon(node.usages[0].sameProject ? 'home' : 'repo');
      return item;
    }
    const u = node.usage;
    const item = new vscode.TreeItem(`${u.path.split('/').pop()}:${u.line}`);
    item.description = u.path.split('/').slice(0, -1).join('/');
    item.tooltip = new vscode.MarkdownString().appendCodeblock(u.snippet);
    item.iconPath = new vscode.ThemeIcon('link-external');
    item.command = { command: 'ripple.crossService.openUsage', title: 'Open in GitLab', arguments: [node] };
    return item;
  }

  private refresh() {
    const r = this.result;
    const used = r?.items.filter((i) => i.usages.length).length ?? 0;
    this.view.description = r ? `${r.items.length} contracts · ${used} used elsewhere` : undefined;
    this.view.badge = used ? { value: used, tooltip: `${used} changed contracts are used in other places` } : undefined;
    void vscode.commands.executeCommand('setContext', 'ripple.crossServiceScanned', !!r);
    this.changed.fire();
  }

  private need(): ReviewSession {
    if (!this.session) throw new Error('No merge request is open in this window.');
    return this.session;
  }
}
