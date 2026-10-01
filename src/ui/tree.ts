import * as path from 'node:path';
import * as vscode from 'vscode';
import { groupFiles, type FileGroup } from '../core/filters';
import type { ChangedFile, ChangeType, TrivialReason } from '../core/types';
import { SEVERITY_ICON } from '../ai/analysis';
import { formatTokens, usage } from '../ai/claude';
import type { GlApprovalRule, GlJob } from '../gitlab/types';
import type { ReviewSession } from './session';

type Node =
  | { kind: 'summary' }
  | { kind: 'ai' }
  | { kind: 'since' }
  | { kind: 'pipeline' }
  | { kind: 'job'; job: GlJob }
  | { kind: 'approvals' }
  | { kind: 'rule'; rule: GlApprovalRule }
  | { kind: 'group'; group: FileGroup }
  | { kind: 'refactor'; key: string; files: ChangedFile[] }
  | { kind: 'file'; file: ChangedFile; parent: string };

const CHANGE_ICON: Record<ChangeType, [string, string]> = {
  added: ['diff-added', 'gitDecoration.addedResourceForeground'],
  modified: ['diff-modified', 'gitDecoration.modifiedResourceForeground'],
  deleted: ['diff-removed', 'gitDecoration.deletedResourceForeground'],
  renamed: ['diff-renamed', 'gitDecoration.renamedResourceForeground'],
};

export const TRIVIAL_LABEL: Record<TrivialReason, string> = {
  generated: 'generated / lockfile',
  'rename-only': 'rename only',
  'mode-only': 'file mode only',
  'whitespace-only': 'whitespace only',
  'import-only': 'imports only',
  'moved-code': 'moved code',
  refactor: 'rename refactor',
};

export class ReviewTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view: vscode.TreeView<Node>;
  private session?: ReviewSession;
  private sub?: vscode.Disposable;

  constructor() {
    this.view = vscode.window.createTreeView('ripple.files', { treeDataProvider: this, showCollapseAll: true, manageCheckboxStateManually: true });
    this.view.onDidChangeCheckboxState(async (e) => {
      if (!this.session) return;
      for (const [node, state] of e.items) {
        const files =
          node.kind === 'file' ? [node.file] : node.kind === 'group' ? node.group.files : node.kind === 'refactor' ? node.files : [];
        await this.session.setViewed(files, state === vscode.TreeItemCheckboxState.Checked);
      }
    });
  }

  setSession(s: ReviewSession | undefined) {
    this.sub?.dispose();
    this.session = s;
    this.sub = s?.onDidChange(() => this.refresh());
    this.refresh();
  }

  dispose() {
    this.sub?.dispose();
    this.view.dispose();
    this.changed.dispose();
  }

  refresh() {
    const s = this.session;
    if (s) {
      const st = s.stats();
      this.view.title = `!${s.entry.iid} · ${st.viewed}/${st.total}`;
      this.view.badge = { value: st.substantive - st.substantiveViewed, tooltip: 'Unviewed substantive files' };
      this.view.message = describeFilters(s);
    } else {
      this.view.title = 'Review';
      this.view.badge = undefined;
      this.view.message = undefined;
    }
    this.changed.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    const s = this.session;
    if (!s) return [];
    if (!node) {
      const top: Node[] = [
        { kind: 'summary' },
        ...(s.since ? [{ kind: 'since' as const }] : []),
        ...(s.meta.pipeline ? [{ kind: 'pipeline' as const }] : []),
        ...(s.meta.approvals?.length ? [{ kind: 'approvals' as const }] : []),
        { kind: 'ai' },
        ...refactorGroups(s),
      ];
      const groups = groupFiles(s.visibleFiles(), (f) => s.groupOf(f), s.groupOrder());
      // One group → skip the extra level.
      if (groups.length === 1) return [...top, ...groups[0].files.map((file) => ({ kind: 'file' as const, file, parent: groups[0].key }))];
      return [...top, ...groups.map((group) => ({ kind: 'group' as const, group }))];
    }
    if (node.kind === 'pipeline') return (s.meta.failedJobs ?? []).map((job) => ({ kind: 'job', job }));
    if (node.kind === 'approvals') return (s.meta.approvals ?? []).map((rule) => ({ kind: 'rule', rule }));
    if (node.kind === 'group') return node.group.files.map((file) => ({ kind: 'file', file, parent: node.group.key }));
    if (node.kind === 'refactor') return node.files.map((file) => ({ kind: 'file', file, parent: `refactor:${node.key}` }));
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const s = this.session!;
    if (node.kind === 'summary') return summaryItem(s);
    if (node.kind === 'ai') return aiItem(s);
    if (node.kind === 'since') return sinceItem(s);
    if (node.kind === 'pipeline') return pipelineItem(s);
    if (node.kind === 'job') return jobItem(node.job);
    if (node.kind === 'approvals') return approvalsItem(s);
    if (node.kind === 'rule') return ruleItem(node.rule);
    if (node.kind === 'group') return groupItem(s, node.group);
    if (node.kind === 'refactor') return refactorItem(s, node);
    return fileItem(s, node.file, node.parent);
  }
}

function summaryItem(s: ReviewSession): vscode.TreeItem {
  const st = s.stats();
  const pct = st.substantive ? Math.round((st.substantiveViewed / st.substantive) * 100) : 100;
  const item = new vscode.TreeItem(`${progressBar(pct)} ${pct}%`);
  item.description = `${st.substantiveViewed}/${st.substantive} substantive · ${st.trivial} trivial`;
  item.tooltip = new vscode.MarkdownString(
    `**${escapeMd(s.mr.title)}**\n\n${s.mr.source_branch} → ${s.mr.target_branch}\n\n` +
      `${st.total} files: ${st.substantive} substantive, ${st.trivial} trivial (hidden: ${s.state.filters.hideTrivial ? 'yes' : 'no'})`,
  );
  item.iconPath = new vscode.ThemeIcon('git-pull-request');
  item.command = { command: 'ripple.openOverview', title: 'Open MR Overview' };
  return item;
}

function sinceItem(s: ReviewSession): vscode.TreeItem {
  const since = s.since!;
  const on = !!s.state.filters.sinceReview;
  const n = since.files.size;
  const item = new vscode.TreeItem(`${n} file${n === 1 ? '' : 's'} changed since ${since.label}`);
  item.description = on ? 'showing only these · click for all' : 'click to show only these';
  item.iconPath = new vscode.ThemeIcon('history', new vscode.ThemeColor(on ? 'charts.blue' : 'foreground'));
  item.tooltip = new vscode.MarkdownString(
    `New commits arrived after ${since.label}. With this on, only files the author changed since then are listed, and their diffs show just those changes (compared with \`${since.base.slice(0, 8)}\`).`,
  );
  item.command = { command: 'ripple.toggleSinceReview', title: 'Toggle since your review' };
  return item;
}

const PIPELINE_ICON: Record<string, [string, string]> = {
  success: ['pass-filled', 'testing.iconPassed'],
  failed: ['error', 'testing.iconFailed'],
  running: ['sync~spin', 'charts.blue'],
  pending: ['clock', 'charts.yellow'],
  canceled: ['circle-slash', 'disabledForeground'],
  skipped: ['debug-step-over', 'disabledForeground'],
  manual: ['debug-pause', 'charts.yellow'],
};

function pipelineItem(s: ReviewSession): vscode.TreeItem {
  const p = s.meta.pipeline!;
  const failed = s.meta.failedJobs?.length ?? 0;
  const item = new vscode.TreeItem(`Pipeline ${p.status}`, failed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
  const cov = coverageTotals(s);
  item.description = [
    failed ? `${failed} failed job${failed === 1 ? '' : 's'}` : '',
    p.forCurrentVersion ? '' : 'for an older commit',
    cov ? `changed lines covered ${cov.pct}%` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const [icon, color] = PIPELINE_ICON[p.status] ?? ['circle-outline', 'foreground'];
  item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
  item.tooltip = new vscode.MarkdownString(
    `Pipeline #${p.id} · ${p.status}${p.forCurrentVersion ? '' : '\n\n⚠ Ran on an older commit than the MR head.'}` +
      (cov ? `\n\nCoverage of changed lines: ${cov.covered}/${cov.measured} (${cov.pct}%), from ${s.meta.coverageSource}` : '\n\nNo coverage report found in the test jobs.'),
  );
  item.command = { command: 'vscode.open', title: 'Open pipeline', arguments: [vscode.Uri.parse(p.web_url)] };
  return item;
}

function jobItem(job: GlJob): vscode.TreeItem {
  const item = new vscode.TreeItem(job.name);
  item.description = job.stage;
  item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
  item.tooltip = 'Open the job log in GitLab';
  item.command = { command: 'vscode.open', title: 'Open job', arguments: [vscode.Uri.parse(job.web_url)] };
  return item;
}

function approvalsItem(s: ReviewSession): vscode.TreeItem {
  const rules = (s.meta.approvals ?? []).filter((r) => r.approvals_required > 0);
  const done = rules.filter((r) => r.approved).length;
  const item = new vscode.TreeItem('Approvals', vscode.TreeItemCollapsibleState.Collapsed);
  item.description = rules.length ? `${done}/${rules.length} rules satisfied` : 'no required approvals';
  item.iconPath = new vscode.ThemeIcon(rules.length && done === rules.length ? 'pass-filled' : 'shield', new vscode.ThemeColor(rules.length && done === rules.length ? 'testing.iconPassed' : 'foreground'));
  return item;
}

function ruleItem(r: GlApprovalRule): vscode.TreeItem {
  const got = r.approved_by.length;
  const item = new vscode.TreeItem(r.name);
  item.description = `${Math.min(got, r.approvals_required)}/${r.approvals_required}${r.approved_by.length ? ` · ${r.approved_by.map((u) => u.name).join(', ')}` : ''}`;
  item.iconPath = new vscode.ThemeIcon(r.approved ? 'pass' : 'circle-large-outline', new vscode.ThemeColor(r.approved ? 'testing.iconPassed' : 'foreground'));
  item.tooltip = new vscode.MarkdownString(
    `**${r.name}**${r.code_owner ? ' (code owners)' : ''} · needs ${r.approvals_required}\n\nCan approve: ${r.eligible_approvers.map((u) => `@${u.username}`).join(', ') || '—'}`,
  );
  return item;
}

function coverageTotals(s: ReviewSession): { measured: number; covered: number; pct: number } | undefined {
  if (!s.meta.coverage?.size) return undefined;
  let measured = 0;
  let covered = 0;
  for (const c of s.meta.coverage.values()) {
    measured += c.measured;
    covered += c.covered;
  }
  return measured ? { measured, covered, pct: Math.round((covered / measured) * 100) } : undefined;
}

/** "✨ AI review" row: run the analysis, or open its summary. */
function aiItem(s: ReviewSession): vscode.TreeItem {
  if (!s.ai) {
    const item = new vscode.TreeItem('AI review: summary, review order, risks');
    item.description = 'click to run';
    item.iconPath = new vscode.ThemeIcon('sparkle');
    item.command = { command: 'ripple.ai.analyze', title: 'Run AI review' };
    return item;
  }
  const high = s.ai.risks.filter((r) => r.severity === 'high').length;
  const item = new vscode.TreeItem('AI summary');
  item.description = `${s.ai.groups.length} review units · ${s.ai.risks.length} risks${high ? ` (${high} high)` : ''} · ${s.ai.options.model}`;
  item.iconPath = new vscode.ThemeIcon('sparkle', new vscode.ThemeColor(high ? 'list.errorForeground' : 'charts.purple'));
  item.tooltip = new vscode.MarkdownString(
    `${s.ai.summary}\n\n---\nClaude usage in this window: ${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out, ${usage.calls} calls`,
  );
  item.command = { command: 'ripple.openOverview', title: 'Open MR Overview' };
  item.contextValue = 'aiDone';
  return item;
}

function groupItem(s: ReviewSession, g: FileGroup): vscode.TreeItem {
  const viewed = g.files.filter((f) => s.isViewed(f)).length;
  const ai = g.key.startsWith('ai:') ? s.ai?.groups.find((x) => x.key === g.key) : undefined;
  const item = new vscode.TreeItem(s.groupTitle(g.key), vscode.TreeItemCollapsibleState.Expanded);
  item.id = `group:${g.key}`;
  const risks = g.files.flatMap((f) => s.risksFor(f.path));
  const worst = risks.find((r) => r.severity === 'high') ?? risks.find((r) => r.severity === 'medium') ?? risks[0];
  item.description = [`${viewed}/${g.files.length}`, worst ? `${SEVERITY_ICON[worst.severity]} ${risks.length}` : ''].filter(Boolean).join(' · ');
  if (ai) item.tooltip = new vscode.MarkdownString(`**${ai.title}**\n\n${ai.why}`);
  item.contextValue = 'group';
  item.iconPath = new vscode.ThemeIcon(viewed === g.files.length ? 'pass-filled' : ai ? 'layers' : 'folder');
  item.checkboxState = viewed === g.files.length ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
  return item;
}

/** Rename refactors shown as one item each, even while trivial files are hidden. */
function refactorGroups(s: ReviewSession): Node[] {
  const f = s.state.filters;
  const byKey = new Map<string, ChangedFile[]>();
  for (const file of s.files) {
    if (!file.refactor || !f.changeTypes.includes(file.change)) continue;
    if (!byKey.has(file.refactor)) byKey.set(file.refactor, []);
    byKey.get(file.refactor)!.push(file);
  }
  return [...byKey].map(([key, files]) => ({ kind: 'refactor', key, files }));
}

function refactorItem(s: ReviewSession, node: { key: string; files: ChangedFile[] }): vscode.TreeItem {
  const viewed = node.files.filter((f) => s.isViewed(f)).length;
  const item = new vscode.TreeItem(`Refactor: ${node.key}`, vscode.TreeItemCollapsibleState.Collapsed);
  item.id = `refactor:${node.key}`;
  item.description = `${node.files.length} files · ${viewed}/${node.files.length} viewed`;
  item.iconPath = new vscode.ThemeIcon('symbol-key');
  item.checkboxState = viewed === node.files.length ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
  item.tooltip = new vscode.MarkdownString(
    `Every changed line in these ${node.files.length} files differs only by the rename **${node.key}**.\n\n` +
      'Skim one or two to confirm, then tick the checkbox to mark all viewed.',
  );
  return item;
}

function fileItem(s: ReviewSession, f: ChangedFile, parent: string): vscode.TreeItem {
  const item = new vscode.TreeItem(path.posix.basename(f.path));
  item.id = `file:${parent}:${f.path}`;
  const size = f.binary ? 'binary' : `+${f.additions} −${f.deletions}`;
  const reason = f.trivial === 'refactor' ? `refactor: ${f.refactor}` : f.trivial ? TRIVIAL_LABEL[f.trivial] : undefined;
  const risks = s.risksFor(f.path);
  const worst = risks.find((r) => r.severity === 'high') ?? risks.find((r) => r.severity === 'medium') ?? risks[0];
  const cov = s.meta.coverage?.get(f.path);
  const mine = s.meta.mine?.has(f.path);
  item.description = [
    mine ? '👤' : undefined,
    worst ? `${SEVERITY_ICON[worst.severity]} ${worst.category}${risks.length > 1 ? ` +${risks.length - 1}` : ''}` : undefined,
    cov?.uncovered.length ? `🧪 ${cov.uncovered.length} untested` : undefined,
    parent.startsWith('refactor:') || s.aiGrouping ? path.posix.dirname(f.path) : reason,
    size,
  ]
    .filter(Boolean)
    .join(' · ');
  const [icon, color] = CHANGE_ICON[f.change];
  item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
  item.checkboxState = s.isViewed(f) ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
  item.contextValue = 'file';
  const tip = new vscode.MarkdownString(
    [
      `\`${f.change === 'renamed' ? `${f.oldPath} → ${f.path}` : f.path}\``,
      `${f.change}${f.trivial ? ` (trivial: ${TRIVIAL_LABEL[f.trivial]})` : ''} · ${size}`,
      ...risks.map((r) => `${SEVERITY_ICON[r.severity]} **${r.category}**${r.line ? ` (line ${r.line})` : ''}: ${r.note}`),
      ...(cov ? [`🧪 Changed lines covered by tests: ${cov.covered}/${cov.measured}${cov.uncovered.length ? ` · not covered: ${cov.uncovered.slice(0, 12).join(', ')}` : ''}`] : []),
      ...(s.meta.owners?.get(f.path) ? [`👤 Code owners: ${s.meta.owners.get(f.path)!.join(', ')}${mine ? ' (you)' : ''}`] : []),
    ].join('\n\n'),
  );
  item.tooltip = tip;
  item.command = { command: 'ripple.openFile', title: 'Open Diff', arguments: [f.path] };
  return item;
}

function describeFilters(s: ReviewSession): string | undefined {
  const f = s.state.filters;
  const parts: string[] = [];
  if (f.changeTypes.length < 4) parts.push(f.changeTypes.join('/'));
  if (f.hideTrivial && s.stats().trivial) parts.push(`${s.stats().trivial} trivial hidden`);
  if (f.viewed !== 'all') parts.push(`${f.viewed} only`);
  if (f.kind !== 'all') parts.push(f.kind === 'src' ? 'no tests' : 'tests only');
  if (f.pathGlob) parts.push(`path: ${f.pathGlob}`);
  if (f.onlyMine) parts.push('only mine');
  if (f.sinceReview && s.since) parts.push(`since ${s.since.label}`);
  if (f.focusGroup !== undefined) parts.push(`focus: ${f.focusGroup}`);
  return parts.length ? `Filters: ${parts.join(' · ')}` : undefined;
}

function progressBar(pct: number): string {
  const filled = Math.round(pct / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}
