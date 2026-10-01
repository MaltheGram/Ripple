import * as vscode from 'vscode';
import type { GitLabClient } from '../gitlab/client';
import type { GlMergeRequest } from '../gitlab/types';

type Section = { kind: 'section'; id: string; label: string; icon: string; load: () => Promise<GlMergeRequest[]>; byProject: boolean };
type Node =
  | Section
  | { kind: 'project'; section: string; path: string; mrs: GlMergeRequest[] }
  | { kind: 'mr'; mr: GlMergeRequest; parent: string }
  | { kind: 'message'; text: string; icon?: string; command?: vscode.Command };

/** "Merge Requests" sidebar: open MRs by section; click one to review it in this window. */
export class MrListTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view: vscode.TreeView<Node>;
  private cache = new Map<string, Promise<GlMergeRequest[]>>();
  private sectionsCache?: Promise<Section[]>;
  private active?: { projectId: number; iid: number };

  constructor(
    private readonly client: () => GitLabClient,
    private readonly signedIn: () => Promise<boolean>,
  ) {
    this.view = vscode.window.createTreeView('ripple.mrs', { treeDataProvider: this, showCollapseAll: true });
  }

  dispose() {
    this.view.dispose();
    this.changed.dispose();
  }

  refresh() {
    this.cache.clear();
    this.sectionsCache = undefined;
    this.changed.fire(undefined);
  }

  setActive(a: { projectId: number; iid: number } | undefined) {
    this.active = a;
    this.changed.fire(undefined);
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      // Empty list → the "Sign in" welcome content shows.
      if (!(await this.signedIn())) return [];
      this.sectionsCache ??= this.sections();
      this.sectionsCache.catch(() => (this.sectionsCache = undefined));
      return this.sectionsCache;
    }
    if (node.kind === 'project') return node.mrs.map((mr) => ({ kind: 'mr', mr, parent: node.section }));
    if (node.kind !== 'section') return [];

    let mrs: GlMergeRequest[];
    try {
      mrs = await this.load(node);
    } catch (e) {
      return [{ kind: 'message', text: `Failed to load: ${e instanceof Error ? e.message : e}`, icon: 'error' }];
    }
    if (!mrs.length) return [{ kind: 'message', text: 'None' }];
    if (!node.byProject) return mrs.map((mr) => ({ kind: 'mr', mr, parent: node.id }));

    const byProject = new Map<string, GlMergeRequest[]>();
    for (const mr of mrs) {
      const p = projectPath(mr);
      if (!byProject.has(p)) byProject.set(p, []);
      byProject.get(p)!.push(mr);
    }
    return [...byProject]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, list]) => ({ kind: 'project', section: node.id, path, mrs: list }));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'section': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `section:${node.id}`;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        return item;
      }
      case 'project': {
        const item = new vscode.TreeItem(node.path, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `project:${node.section}:${node.path}`;
        item.description = String(node.mrs.length);
        item.iconPath = new vscode.ThemeIcon('repo');
        return item;
      }
      case 'mr':
        return this.mrItem(node.mr, node.parent);
      case 'message': {
        const item = new vscode.TreeItem(node.text);
        item.iconPath = node.icon ? new vscode.ThemeIcon(node.icon) : undefined;
        item.command = node.command;
        return item;
      }
    }
  }

  private mrItem(mr: GlMergeRequest, parent: string): vscode.TreeItem {
    const isActive = this.active?.projectId === mr.project_id && this.active.iid === mr.iid;
    const item = new vscode.TreeItem(`!${mr.iid} ${mr.title.replace(/^(Draft:|\[Draft\]|WIP:)\s*/i, '')}`);
    item.id = `mr:${parent}:${mr.project_id}:${mr.iid}`;
    item.description = [isActive ? '● reviewing' : undefined, mr.author.name, ago(mr.updated_at)].filter(Boolean).join(' · ');
    item.iconPath = new vscode.ThemeIcon(
      isActive ? 'eye' : mr.draft ? 'git-pull-request-draft' : 'git-pull-request',
      isActive ? new vscode.ThemeColor('charts.blue') : undefined,
    );
    item.tooltip = new vscode.MarkdownString(
      `**${escapeMd(mr.title)}**\n\n${escapeMd(projectPath(mr))} !${mr.iid}\n\n` +
        `${escapeMd(mr.source_branch)} → ${escapeMd(mr.target_branch)}\n\n${escapeMd(mr.author.name)}` +
        (mr.user_notes_count ? ` · ${mr.user_notes_count} comments` : ''),
    );
    item.contextValue = 'mr';
    item.command = { command: 'ripple.reviewMr', title: 'Review', arguments: [mr] };
    return item;
  }

  private load(s: Section): Promise<GlMergeRequest[]> {
    let p = this.cache.get(s.id);
    if (!p) {
      p = s.load();
      this.cache.set(s.id, p);
      p.catch(() => this.cache.delete(s.id));
    }
    return p;
  }

  /** Section list incl. the groups lookup is cached until refresh; MR lists load per section, in parallel. */
  private async sections(): Promise<Section[]> {
    const c = this.client();
    const me = c.currentUser();
    let groups = vscode.workspace.getConfiguration('ripple.gitlab').get<string[]>('groups', []);
    if (!groups.length) groups = (await c.myTopGroups().catch(() => [])).map((g) => g.full_path);
    const out: Section[] = [
      { kind: 'section', id: 'review', label: 'Review requested', icon: 'account', byProject: false, load: async () => c.reviewRequests((await me).username) },
      { kind: 'section', id: 'assigned', label: 'Assigned to me', icon: 'person', byProject: false, load: () => c.assignedToMe() },
      { kind: 'section', id: 'created', label: 'Created by me', icon: 'edit', byProject: false, load: () => c.createdByMe() },
    ];
    for (const g of groups) {
      out.push({ kind: 'section', id: `group:${g}`, label: `All open in ${g}`, icon: 'organization', byProject: true, load: () => c.groupMergeRequests(g) });
    }
    return out;
  }
}

function projectPath(mr: GlMergeRequest): string {
  return mr.references?.full?.replace(/!\d+$/, '') ?? `project ${mr.project_id}`;
}

function ago(iso?: string): string | undefined {
  if (!iso) return undefined;
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
