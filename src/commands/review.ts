import * as vscode from 'vscode';
import type { ChangeType } from '../core/types';
import type { SortMode } from '../core/filters';
import { runAnalysis } from '../ai/features';
import { locate, openDiff, revealInDiff } from '../ui/diff';
import { overviewUri } from '../ui/overview';
import type { ReviewSession } from '../ui/session';
import type { App } from '../app';
import { confirmDiscard } from './mergeRequests';

/** The Review list: refresh, filters, sorting, grouping, viewed state, navigation, submit and approve. */
export function registerReviewCommands(app: App) {
  const { context } = app;
  const need = () => app.need();
  app.command('ripple.refresh', async () => {
    const s = need();
    const before = s.refs.head_sha;
    await vscode.window.withProgress({ location: { viewId: 'ripple.files' } }, () => s.refresh({ fetch: true, confirmDiscard }));
    app.impact.reset();
    app.traceLens.refresh();
    if (s.refs.head_sha !== before) void vscode.window.showInformationMessage(`!${s.entry.iid} has new commits. Changed files are unviewed again.`);
  });

  app.command('ripple.filter', () => pickFilters(need()));
  app.command('ripple.sort', async () => {
    const s = need();
    const modes: { label: string; mode: SortMode; detail: string }[] = [
      { label: 'Suggested order', mode: 'suggested', detail: 'Migrations → types/DTOs → repositories → services → controllers → other → tests' },
      { label: 'Path', mode: 'path', detail: 'Alphabetical' },
      { label: 'Size', mode: 'size', detail: 'Most changed lines first' },
    ];
    const pick = await vscode.window.showQuickPick(
      modes.map((m) => ({ ...m, picked: m.mode === s.state.filters.sort, description: m.mode === s.state.filters.sort ? 'current' : '' })),
      { title: 'Sort files' },
    );
    if (pick) await s.updateFilters({ sort: pick.mode });
  });
  app.command('ripple.toggleTrivial', () => {
    const s = need();
    return s.updateFilters({ hideTrivial: !s.state.filters.hideTrivial });
  });
  app.command('ripple.markTrivialViewed', () => {
    const s = need();
    return s.setViewed(s.files.filter((f) => f.trivial), true);
  });
  app.command('ripple.focusGroup', (node?: { kind: string; group?: { key: string } }) => {
    if (node?.group) return need().updateFilters({ focusGroup: node.group.key });
  });
  app.command('ripple.clearFocus', () => need().updateFilters({ focusGroup: undefined }));

  app.command('ripple.openFile', (path: string) => {
    const s = need();
    const f = s.fileByPath(path);
    if (f) return openDiff(s, f);
  });
  app.command('ripple.nextUnviewed', () => openNext(need(), false));
  app.command('ripple.markViewedAndNext', () => openNext(need(), true));
  app.command('ripple.openInGitLab', () => vscode.env.openExternal(vscode.Uri.parse(need().mr.web_url)));

  app.command('ripple.submitReview', async () => {
    const s = need();
    await s.reloadComments();
    const n = s.drafts.length;
    if (n === 0) {
      void vscode.window.showInformationMessage('No draft comments to publish. Use "Add to Review" on a comment first.');
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `Publish ${n} draft comment${n === 1 ? '' : 's'} on !${s.entry.iid}?`,
      { modal: true, detail: 'They become visible to everyone on the merge request.' },
      'Publish',
      'Publish & Approve',
    );
    if (!choice) return;
    await s.client.publishDrafts(s.entry.projectId, s.entry.iid);
    if (choice === 'Publish & Approve') await s.client.approve(s.entry.projectId, s.entry.iid, s.refs.head_sha);
    await s.reloadComments();
    void vscode.window.showInformationMessage(`Published ${n} comment${n === 1 ? '' : 's'}${choice === 'Publish & Approve' ? ' and approved' : ''}.`);
  });
  app.command('ripple.approve', async () => {
    const s = need();
    const ok = await vscode.window.showInformationMessage(`Approve !${s.entry.iid} "${s.mr.title}"?`, { modal: true }, 'Approve');
    if (!ok) return;
    await s.client.approve(s.entry.projectId, s.entry.iid, s.refs.head_sha);
    void vscode.window.showInformationMessage(`Approved !${s.entry.iid}.`);
  });
  app.command('ripple.unapprove', async () => {
    const s = need();
    await s.client.unapprove(s.entry.projectId, s.entry.iid);
    void vscode.window.showInformationMessage(`Approval revoked on !${s.entry.iid}.`);
  });
  app.command('ripple.groupBy', async () => {
    const s = need();
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'Folder', description: 'Feature folders (dto/, tests/ folded into their feature)', value: 'folder' as const },
        { label: 'AI review units', description: s.ai ? `${s.ai.groups.length} units in suggested order` : 'runs the AI review first', value: 'ai' as const },
      ],
      { title: 'Group files by' },
    );
    if (!pick) return;
    if (pick.value === 'ai' && !s.ai) return runAnalysis(s, context);
    await s.updateFilters({ groupBy: pick.value, focusGroup: undefined });
  });
  app.command('ripple.openOverview', async () => {
    const doc = await vscode.workspace.openTextDocument(overviewUri(need()));
    await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
    await vscode.window.showTextDocument(doc, { preview: true });
  });
  app.command('ripple.toggleSinceReview', () => {
    const s = need();
    if (!s.since) throw new Error('Nothing new since your last review (or you have not reviewed this MR yet).');
    return s.updateFilters({ sinceReview: !s.state.filters.sinceReview });
  });
  app.command('ripple.markReviewed', async () => {
    const s = need();
    await s.markReviewed();
    void vscode.window.showInformationMessage(`Marked this version of !${s.entry.iid} as reviewed. Next time you'll see only what changed after it.`);
  });
  app.command('ripple.compareWithVersion', async () => {
    const s = need();
    const versions = await s.client.mrVersions(s.entry.projectId, s.entry.iid);
    const reviewed = s.state.reviewed?.headSha;
    const items = versions.map((v, i) => ({
      label: `v${versions.length - i}${v.head_commit_sha === s.refs.head_sha ? ' (current)' : ''}${v.head_commit_sha === reviewed ? ' · you reviewed this' : ''}`,
      description: new Date(v.created_at).toLocaleString(),
      detail: v.head_commit_sha.slice(0, 12),
      sha: v.head_commit_sha,
      n: versions.length - i,
    }));
    const pick = await vscode.window.showQuickPick(
      [{ label: 'Whole MR (no comparison)', sha: '', n: 0, description: '', detail: '' }, ...items.filter((i) => i.sha !== s.refs.head_sha)],
      { title: 'Show changes since…' },
    );
    if (!pick) return;
    if (!pick.sha) {
      await s.compareWith(undefined);
      return s.updateFilters({ sinceReview: false });
    }
    await s.compareWith(pick.sha, `v${pick.n}`);
  });
  app.command('ripple.revealChange', (file: string, line: number) => {
    const s = need();
    const f = s.fileByPath(file);
    if (f) return revealInDiff(s, f, line);
  });
}

async function openNext(s: ReviewSession, markCurrent: boolean) {
  const visible = s.visibleFiles();
  const editor = vscode.window.activeTextEditor;
  const current = editor ? locate(s, editor.document.uri)?.file : s.fileByPath(s.state.lastOpened ?? '');
  if (markCurrent && current) await s.setViewed([current], true);

  const start = current ? visible.findIndex((f) => f.path === current.path) : -1;
  const ordered = [...visible.slice(start + 1), ...visible.slice(0, start + 1)];
  const next = ordered.find((f) => !s.isViewed(f));
  if (next) return openDiff(s, next);

  const action = await vscode.window.showInformationMessage('All visible files are viewed. 🎉', 'Submit Review', 'Show Trivial Files');
  if (action === 'Submit Review') await vscode.commands.executeCommand('ripple.submitReview');
  if (action === 'Show Trivial Files') await s.updateFilters({ hideTrivial: false });
}

type FilterPick = vscode.QuickPickItem & { apply: 'change' | 'trivial' | 'unviewed' | 'viewed' | 'src' | 'test' | 'path' | 'mine'; change?: ChangeType };

async function pickFilters(s: ReviewSession) {
  const f = s.state.filters;
  const counts = (c: ChangeType) => s.files.filter((x) => x.change === c).length;
  const items: FilterPick[] = [
    { label: 'Change type', kind: vscode.QuickPickItemKind.Separator, apply: 'change' },
    ...(['modified', 'added', 'deleted', 'renamed'] as ChangeType[]).map<FilterPick>((c) => ({
      label: c[0].toUpperCase() + c.slice(1),
      description: String(counts(c)),
      apply: 'change',
      change: c,
      picked: f.changeTypes.includes(c),
    })),
    { label: 'Show', kind: vscode.QuickPickItemKind.Separator, apply: 'change' },
    { label: 'Hide trivial files', description: `${s.stats().trivial} files`, apply: 'trivial', picked: f.hideTrivial },
    { label: 'Only unviewed', apply: 'unviewed', picked: f.viewed === 'unviewed' },
    { label: 'Only viewed', apply: 'viewed', picked: f.viewed === 'viewed' },
    { label: 'Hide tests', apply: 'src', picked: f.kind === 'src' },
    { label: 'Only tests', apply: 'test', picked: f.kind === 'test' },
    ...(s.meta.mine ? [{ label: 'Only files I own (CODEOWNERS)', description: `${s.meta.mine.size} files`, apply: 'mine' as const, picked: !!f.onlyMine }] : []),
    { label: 'Path filter…', description: f.pathGlob ? `current: ${f.pathGlob}` : 'text or glob', apply: 'path', picked: !!f.pathGlob },
  ];
  const picked = await vscode.window.showQuickPick(items, { canPickMany: true, title: 'Filter files' });
  if (!picked) return;
  const has = (a: FilterPick['apply']) => picked.some((p) => p.apply === a);

  let pathGlob: string | undefined;
  if (has('path')) {
    pathGlob = await vscode.window.showInputBox({
      title: 'Path filter',
      prompt: 'Text matches anywhere in the path; globs like "apps/api/**/*.ts" also work.',
      value: f.pathGlob ?? '',
    });
    if (pathGlob === undefined) return;
    pathGlob = pathGlob.trim() || undefined;
  }

  const changeTypes = picked.filter((p) => p.change).map((p) => p.change!);
  await s.updateFilters({
    changeTypes: changeTypes.length ? changeTypes : ['added', 'modified', 'deleted', 'renamed'],
    hideTrivial: has('trivial'),
    viewed: has('unviewed') ? 'unviewed' : has('viewed') ? 'viewed' : 'all',
    kind: has('src') ? 'src' : has('test') ? 'test' : 'all',
    onlyMine: has('mine'),
    pathGlob,
  });
}
