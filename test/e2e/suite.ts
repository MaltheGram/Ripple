import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';
import { impactOf } from '../../src/analysis/impact';
import { routeIndexFor, TraceBuilder, traceToMermaid } from '../../src/analysis/trace';
import { startFakeGitLab } from './fakeGitlab';

/**
 * Smoke test in a real VS Code: fake GitLab + real local git repo.
 * Covers checkout → classify → filters → diff → go-to-definition → comments → approve.
 */
export async function run(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'br-e2e-'));
  const { repo, baseSha, headSha } = makeRepo(path.join(root, 'origin'));
  const gl = await startFakeGitLab({ repoUrl: repo, baseSha, headSha });
  const step = (name: string) => console.log(`  ✓ ${name}`);

  try {
    const cfg = vscode.workspace.getConfiguration('ripple');
    await cfg.update('gitlab.baseUrl', gl.url, vscode.ConfigurationTarget.Global);
    await cfg.update('storageRoot', path.join(root, 'storage'), vscode.ConfigurationTarget.Global);

    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'ripple')! as vscode.Extension<TestApi>;
    const api = await ext.activate();
    api.useToken('fake-token');

    // Same path as clicking an MR in the "Merge Requests" sidebar.
    const [listed] = (await (await fetch(`${gl.url}/api/v4/groups/acme/merge_requests`)).json()) as unknown[];
    await vscode.commands.executeCommand('ripple.reviewMr', listed);
    const s = api.session()!;
    assert.ok(s, 'session started');
    step(`checked out MR into ${s.entry.worktree}`);

    // Classification
    const by = Object.fromEntries(s.files.map((f) => [f.path, f]));
    assert.deepEqual(
      Object.keys(by).sort(),
      ['package-lock.json', 'src/app.service.ts', 'src/format.ts', 'src/legacy.ts', 'src/math.ts', 'src/order.dto.ts'],
    );
    assert.equal(by['package-lock.json'].trivial, 'generated');
    assert.equal(by['src/format.ts'].trivial, 'whitespace-only');
    assert.equal(by['src/order.dto.ts'].change, 'added');
    assert.equal(by['src/legacy.ts'].change, 'deleted');
    assert.equal(by['src/app.service.ts'].trivial, undefined);
    step('classified files: ' + s.files.map((f) => `${f.path}=${f.trivial ?? f.change}`).join(', '));

    // Default view hides trivial; suggested order puts DTO before service.
    assert.deepEqual(s.visibleFiles().map((f) => f.path), ['src/order.dto.ts', 'src/app.service.ts', 'src/legacy.ts', 'src/math.ts']);
    await s.updateFilters({ changeTypes: ['modified'] });
    assert.deepEqual(s.visibleFiles().map((f) => f.path), ['src/app.service.ts', 'src/math.ts']);
    await s.updateFilters({ changeTypes: ['added', 'modified', 'deleted', 'renamed'] });
    step('filters (trivial hidden, modified-only, suggested order)');

    // Diff opens with the real worktree file on the right.
    await vscode.commands.executeCommand('ripple.openFile', 'src/app.service.ts');
    const right = vscode.Uri.file(path.join(s.entry.worktree, 'src/app.service.ts'));
    await waitFor(() => vscode.window.activeTextEditor?.document.uri.fsPath === right.fsPath, 'diff editor');
    step('opened diff');

    // CMD+click: definition of `add(` resolves into the worktree.
    const doc = await vscode.workspace.openTextDocument(right);
    const callLine = doc.getText().split('\n').findIndex((l) => l.includes('add(1, 2)'));
    const pos = new vscode.Position(callLine, doc.lineAt(callLine).text.indexOf('add(') + 1);
    // TS may first answer with the local import binding while the project loads; wait for the real declaration.
    const mathTs = path.join(s.entry.worktree, 'src/math.ts');
    const uriOf = (d: vscode.Location | vscode.LocationLink) => ('targetUri' in d ? d.targetUri : d.uri);
    let last: string[] = [];
    const target = await waitFor(async () => {
      const r = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', right, pos);
      last = (r ?? []).map((d) => `${uriOf(d).fsPath}:${('targetRange' in d ? d.targetRange : d.range).start.line}`);
      return (r ?? []).map(uriOf).find((u) => u.fsPath === mathTs);
    }, 'definition provider', 60_000).catch((e) => {
      throw new Error(`${e.message}; last result: ${JSON.stringify(last)}`);
    });
    assert.equal(target.fsPath, path.join(s.entry.worktree, 'src/math.ts'));
    step(`go-to-definition → ${path.relative(s.entry.worktree, target.fsPath)}`);

    // Trace of the changed sum3: up through the controller, across HTTP to the RTK endpoint, the hook user and the
    // component that renders it; down to add. Real TypeScript language server + route index.
    const index = await routeIndexFor(s);
    assert.deepEqual(index.routes.map((r) => [r.method, r.path, r.handler]), [['GET', '/orders/:id/total', 'handle']]);
    assert.deepEqual(index.endpoints.map((e) => [e.name, e.method, e.path]), [['getOrderTotal', 'GET', '/orders/:p/total']]);
    const svcDoc = await vscode.workspace.openTextDocument(right);
    const sum3Line = svcDoc.getText().split('\n').findIndex((l) => l.includes('function sum3'));
    let lastTrace = '';
    const tr = await waitFor(async () => {
      const t = await new TraceBuilder(s, index).start(right, new vscode.Position(sum3Line, 17));
      lastTrace = JSON.stringify({ warnings: t.warnings, nodes: t.nodes.map((n) => `${n.name}[${n.layer}]${n.more.up ? '+up' : ''}`), edges: t.edges.map((e) => `${t.nodes.find((n) => n.id === e.from)?.name}-${e.kind}->${t.nodes.find((n) => n.id === e.to)?.name}`) });
      return t.nodes.some((n) => n.name === 'OrderPage') ? t : undefined;
    }, 'trace reaches the React page', 30_000).catch((e) => {
      throw new Error(`${e.message}: ${lastTrace}`);
    });
    const byName = (n: string) => tr.nodes.find((x) => x.name === n)!;
    const has = (from: string, to: string, kind: string) => tr.edges.some((e) => e.from === byName(from).id && e.to === byName(to).id && e.kind === kind);
    assert.equal(byName('sum3').role, 'target');
    assert.equal(byName('sum3').changed, true);
    assert.deepEqual([byName('handle').layer, byName('handle').changed, byName('handle').detail], ['controller', false, 'GET /orders/:id/total']);
    assert.equal(byName('getOrderTotal').layer, 'api');
    assert.equal(byName('OrderTotal').layer, 'component');
    assert.ok(has('handle', 'sum3', 'calls'), 'controller calls sum3');
    assert.ok(has('getOrderTotal', 'handle', 'http'), 'endpoint → controller over HTTP');
    assert.ok(has('OrderTotal', 'getOrderTotal', 'uses'), 'component uses the RTK hook');
    assert.ok(has('OrderPage', 'OrderTotal', 'renders'), 'page renders the component');
    assert.ok(has('sum3', 'add', 'calls'), 'sum3 calls add');
    assert.match(traceToMermaid(tr), /^flowchart LR/);

    // Frontend start: from the component down across HTTP to the backend handler.
    const tsx = vscode.Uri.file(path.join(s.entry.worktree, 'src/web/OrderTotal.tsx'));
    const tsxDoc = await vscode.workspace.openTextDocument(tsx);
    const compLine = tsxDoc.getText().split('\n').findIndex((l) => l.includes('function OrderTotal'));
    const fe = await new TraceBuilder(s, index).start(tsx, new vscode.Position(compLine, 17));
    const feName = (n: string) => fe.nodes.find((x) => x.name === n);
    assert.ok(feName('getOrderTotal') && feName('handle'), `frontend trace reaches the controller: ${fe.nodes.map((n) => n.name).join(', ')}`);
    assert.ok(fe.edges.some((e) => e.from === feName('getOrderTotal')!.id && e.to === feName('handle')!.id && e.kind === 'http'));

    const [addImpact] = await impactOf(s, by['src/math.ts']);
    assert.deepEqual(addImpact.callers.map((c) => [c.label, c.inMr]).sort(), [['app.service.ts (top level)', true], ['sum3', true]]);
    step(`trace: ${tr.nodes.map((n) => `${n.name}[${n.layer}]`).join(' ')}; frontend → HTTP → controller works; impact unchanged`);

    // Comments: draft on an added line, draft on an unchanged line, immediate comment.
    const threads = vscode.comments.createCommentController('e2e', 'e2e');
    const reply = (line: number, text: string, uri = right): vscode.CommentReply => ({
      thread: threads.createCommentThread(uri, new vscode.Range(line - 1, 0, line - 1, 0), []),
      text,
    });
    await vscode.commands.executeCommand('ripple.comment.addDraft', reply(4, 'Why is this needed?'));
    await vscode.commands.executeCommand('ripple.comment.addDraft', reply(1, 'Nit: header'));
    const leftLegacy = vscode.Uri.from({
      scheme: 'ripple',
      path: '/src/legacy.ts',
      query: new URLSearchParams({ ref: baseSha, gitDir: s.entry.gitDir }).toString(),
    });
    await vscode.commands.executeCommand('ripple.comment.postNow', reply(1, 'Is anything still using this?', leftLegacy));
    await waitFor(() => gl.drafts.length === 2 && gl.discussions.length === 1, 'comments reach GitLab');

    const [added, unchanged] = gl.drafts.map((d) => d.position);
    assert.deepEqual(pick(added), { new_path: 'src/app.service.ts', old_path: 'src/app.service.ts', new_line: 4, old_line: undefined, base_sha: baseSha, head_sha: headSha });
    assert.deepEqual(pick(unchanged), { new_path: 'src/app.service.ts', old_path: 'src/app.service.ts', new_line: 1, old_line: 1, base_sha: baseSha, head_sha: headSha });
    assert.deepEqual(pick(gl.discussions[0].notes[0].position), { new_path: 'src/legacy.ts', old_path: 'src/legacy.ts', new_line: undefined, old_line: 1, base_sha: baseSha, head_sha: headSha });
    await waitFor(() => s.drafts.length === 2 && s.discussions.length === 1, 'session reloads comments');

    // Multi-line draft over new lines 4 (added) - 5 (unchanged) → line_range; general comment from the MR overview → no position.
    await vscode.commands.executeCommand('ripple.comment.addDraft', {
      thread: threads.createCommentThread(right, new vscode.Range(3, 0, 4, 0), []),
      text: 'These two lines',
    });
    const overview = vscode.Uri.from({ scheme: 'ripple-mr', path: '/!1 overview.md', query: '7' });
    await vscode.commands.executeCommand('ripple.comment.postNow', {
      thread: threads.createCommentThread(overview, new vscode.Range(3, 0, 3, 0), []),
      text: 'Overall looks good',
    });
    await waitFor(() => gl.drafts.length === 3 && gl.discussions.length === 2, 'range + general comments reach GitLab');
    const range = gl.drafts[2].position;
    assert.equal(range.new_line, 5);
    assert.deepEqual(
      [range.line_range.start.new_line, range.line_range.start.type, range.line_range.end.new_line, range.line_range.end.type, range.line_range.end.old_line],
      [4, 'new', 5, undefined, 4],
    );
    assert.match(range.line_range.start.line_code, /^[0-9a-f]{40}_\d+_4$/);
    assert.equal(gl.discussions[1].notes[0].position, undefined);
    assert.match((await vscode.workspace.openTextDocument(overview)).getText(), /^# !1 Add order pagination/);
    step('multi-line draft sends line_range; general comment from MR overview has no position');
    step('comments: 2 drafts (added + unchanged line) and 1 posted on deleted file, positions correct');

    // Reply as draft into the existing thread, then publish.
    await s.client.createDraft(7, 1, { note: 'Following up', in_reply_to_discussion_id: gl.discussions[0].id });
    await s.client.publishDrafts(7, 1);
    await s.reloadComments();
    assert.equal(s.drafts.length, 0);
    assert.equal(s.discussions.length, 6);
    step('published drafts');

    // Viewed state + next unviewed.
    await s.setViewed([by['src/order.dto.ts']], true);
    await vscode.commands.executeCommand('ripple.nextUnviewed');
    await waitFor(() => s.state.lastOpened === 'src/legacy.ts', 'next unviewed after app.service.ts');
    assert.equal(s.stats().substantiveViewed, 1);
    await vscode.commands.executeCommand('ripple.markTrivialViewed');
    assert.equal(s.stats().viewed, 3);
    step('viewed state, next unviewed, mark trivial viewed');

    await s.client.approve(7, 1, s.refs.head_sha);
    assert.deepEqual(gl.approvals, [headSha]);
    step('approve with head sha');

    // Cross-service: the added OrderDto is used in another project; partial matches and MR files are ignored.
    await vscode.commands.executeCommand('ripple.crossService.scan');
    const cross = await waitFor(() => api.crossService(), 'cross-service scan');
    const dtoImpact = cross.items.find((i) => i.contract.name === 'OrderDto')!;
    assert.equal(dtoImpact.contract.impact, 'added');
    assert.deepEqual(dtoImpact.usages.map((u) => [u.projectPath, u.path, u.line]), [['acme/web', 'src/api.ts', 10]]);
    assert.match(dtoImpact.usages[0].url, /\/acme\/web\/-\/blob\/main\/src\/api\.ts#L10$/);
    const draftsBeforeCross = gl.drafts.length;
    await vscode.commands.executeCommand('ripple.crossService.comment', { kind: 'contract', item: dtoImpact });
    await waitFor(() => gl.drafts.length === draftsBeforeCross + 1, 'cross-service draft');
    assert.match(gl.drafts.at(-1).note, /Cross-service impact\*\*: `OrderDto`[\s\S]*\*\*acme\/web\*\*[\s\S]*src\/api\.ts:10/);
    assert.equal(gl.drafts.at(-1).position.new_path, 'src/order.dto.ts');
    step('cross-service: contract found, used in acme/web (partial match + MR files filtered), draft comment on declaration');

    // AI (fake `claude`): sandbox flags, analysis → review units, order and risks, suggestion call.
    const claudeLog = path.join(root, 'claude.log');
    process.env.BR_FAKE_CLAUDE_LOG = claudeLog;
    await cfg.update('ai.claudePath', path.join(__dirname, '..', 'test', 'e2e', 'fake-claude.mjs'), vscode.ConfigurationTarget.Global);
    const calls = () => readFileSync(claudeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; input: string });
    const prompts = () => calls().map((c) => c.args);
    const deep = { model: 'sonnet', depth: 'deep', maxTokens: 30000, scope: 'all', includeTests: true, focus: ['security'] };
    await vscode.commands.executeCommand('ripple.ai.analyze', deep);
    await waitFor(() => s.ai, 'AI analysis');
    assert.equal(s.state.filters.groupBy, 'ai');
    assert.deepEqual(s.ai!.groups.map((g) => [g.title, g.files]), [
      ['Types', ['src/order.dto.ts']],
      ['Core logic', ['src/app.service.ts', 'src/math.ts']],
      ['Other changes', ['src/legacy.ts']],
    ]);
    assert.equal(s.visibleFiles()[0].path, 'src/order.dto.ts');
    assert.equal(s.risksFor('src/app.service.ts')[0].severity, 'high');
    const deepArgs = prompts()[0];
    assert.equal(deepArgs[deepArgs.indexOf('--tools') + 1], 'Read,Grep,Glob', 'deep mode: read-only tools');
    assert.ok(deepArgs.includes('--max-budget-usd') && deepArgs.includes('--restricted'));

    // Same version + same options → blocked (no new call). Different options → new call.
    await vscode.commands.executeCommand('ripple.ai.analyze', deep);
    assert.equal(prompts().length, 1, 'second identical AI review must not call Claude');
    await vscode.commands.executeCommand('ripple.ai.analyze', { ...deep, depth: 'diff' });
    await waitFor(() => prompts().length === 2, 'AI review with new options');
    assert.equal(prompts()[1][prompts()[1].indexOf('--tools') + 1], '', 'non-deep: no tools');

    await vscode.commands.executeCommand('ripple.openFile', 'src/app.service.ts');
    await waitFor(() => vscode.window.activeTextEditor?.document.uri.fsPath === right.fsPath, 'diff for suggestions');
    await vscode.commands.executeCommand('ripple.ai.suggestComments');
    await vscode.commands.executeCommand('ripple.ai.suggestComments');
    assert.equal(prompts().length, 3, 'suggestions generated once per file + options');
    for (const a of prompts()) for (const flag of ['--restricted', '--strict-mcp-config', '--no-session-persistence']) assert.ok(a.includes(flag), flag);
    // Explain an untouched method in a file outside the MR: its changed dependency (sum3) must be in the context.
    const ctl = await vscode.window.showTextDocument(vscode.Uri.file(path.join(s.entry.worktree, 'src/order.controller.ts')));
    const handleLine = ctl.document.getText().split('\n').findIndex((l) => l.includes('handle()'));
    ctl.selection = new vscode.Selection(handleLine, 4, handleLine, 4);
    await vscode.commands.executeCommand('ripple.ai.explain');
    const explain = calls().at(-1)!;
    assert.match(explain.input, /Selected code: OrderController\.handle/);
    assert.match(explain.input, /NOT changed by the MR/);
    assert.match(explain.input, /### sum3 \(src\/app\.service\.ts:\d+-\d+\)/);
    assert.match(explain.input, /the selected code itself did not change/);
    await vscode.commands.executeCommand('ripple.ai.explain');
    assert.equal(calls().length, 4, 'same selection + version + options → no new call');
    // Follow-up on the explanation: same context + question; asking the same again is free.
    await vscode.commands.executeCommand('ripple.ai.explainAsk', 'What if c is negative?');
    assert.match(calls().at(-1)!.input, /Follow-up question from the reviewer\nWhat if c is negative\?/);
    assert.match(calls().at(-1)!.input, /### sum3 \(src\/app\.service\.ts/, 'follow-up reuses the gathered context');
    await vscode.commands.executeCommand('ripple.ai.explainAsk', 'What if c is negative?');
    assert.equal(calls().length, 5, 'same follow-up → no new call');

    // Hover hint on the untouched call to the changed sum3 (language server only).
    const sumCol = ctl.document.lineAt(handleLine + 1).text.indexOf('sum3') + 1;
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', ctl.document.uri, new vscode.Position(handleLine + 1, sumCol));
    const text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
    assert.match(text, /Affected by this MR\*\*: `sum3` changed in `src\/app\.service\.ts:\d+-\d+`/);

    // Whole file.
    await vscode.commands.executeCommand('ripple.ai.explainFile');
    assert.match(calls().at(-1)!.input, /WHOLE FILE/);
    assert.match(calls().at(-1)!.input, /Selected code: order\.controller\.ts \(whole file\)/);
    await vscode.commands.executeCommand('ripple.ai.explainFile');
    assert.equal(calls().length, 6, 'same whole-file explain → no new call');

    const draftsBefore = gl.drafts.length;
    await vscode.commands.executeCommand('ripple.ai.explainToComment');
    await waitFor(() => gl.drafts.length === draftsBefore + 1, 'explanation added as draft');
    const general = gl.drafts.at(-1);
    assert.equal(general.position, null, 'file outside the MR → general draft');
    assert.match(general.note, /src\/order\.controller\.ts:\d+-\d+` \(not changed in this MR\)/);
    assert.match(general.note, /Caused|app\.service\.ts:16/);

    // Old side: explain removed code of the deleted legacy.ts, then add it as a comment on the old line.
    const oldDoc = vscode.Uri.from({ scheme: 'ripple', path: '/src/legacy.ts', query: new URLSearchParams({ ref: baseSha, gitDir: s.entry.gitDir }).toString() });
    const oldEditor = await vscode.window.showTextDocument(oldDoc);
    oldEditor.selection = new vscode.Selection(0, 0, 0, 5);
    await vscode.commands.executeCommand('ripple.ai.explain');
    assert.match(calls().at(-1)!.input, /OLD version of the code/);
    await vscode.commands.executeCommand('ripple.ai.explainToComment');
    await waitFor(() => gl.drafts.length === draftsBefore + 2, 'old-side explanation draft');
    assert.deepEqual([gl.drafts.at(-1).position.old_line, gl.drafts.at(-1).position.new_line], [1, undefined]);
    step('explain selection: outside-MR code linked to changed sum3; old side works; add-as-comment drafts; repeat blocked');

    step('AI: sandboxed calls; deep mode read-only + budget cap; review units/order/risks; repeat clicks blocked unless options change');

    // Review meta: approvals, CODEOWNERS, pipeline, coverage of changed lines.
    gl.codeowners = '[Backend]\nsrc/ @tester\n';
    gl.lcov = ['SF:/builds/acme/demo/src/app.service.ts', 'DA:4,1', 'DA:15,1', 'DA:17,0', 'DA:18,3', 'end_of_record'].join('\n');
    await s.reloadMeta();
    assert.deepEqual([s.meta.pipeline?.status, s.meta.pipeline?.forCurrentVersion, s.meta.failedJobs?.map((j) => j.name)], ['failed', true, ['lint']]);
    assert.deepEqual(s.meta.approvals?.map((r) => [r.name, r.approved]), [['Backend', false]]);
    assert.deepEqual(s.meta.coverage?.get('src/app.service.ts'), { measured: 3, covered: 2, uncovered: [17] });
    assert.ok(s.meta.mine?.has('src/app.service.ts'), 'CODEOWNERS: tester owns src/');
    step('review meta: pipeline + failed job, approval rule, coverage of changed lines (1 untested), code owners');

    // Comment labels + next unresolved thread + line history hover.
    await vscode.commands.executeCommand('ripple.comment.postNow', {
      thread: threads.createCommentThread(right, new vscode.Range(0, 0, 0, 0), []),
      text: 'nit: tidy this import',
    });
    await waitFor(() => gl.discussions.some((d) => d.notes[0].body === '**nit:** tidy this import'), 'labelled comment');
    await s.reloadComments();
    await vscode.commands.executeCommand('ripple.nextThread');
    const threadEditor = await waitFor(() => vscode.window.activeTextEditor, 'jump to unresolved thread');
    assert.ok(s.files.some((f) => threadEditor.document.uri.path.endsWith(f.path) || threadEditor.document.uri.path.endsWith(f.oldPath)));
    const hov = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', right, new vscode.Position(16, 2));
    const hovText = hov.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
    assert.match(hovText, /Previously[\s\S]*Anna[\s\S]*!5 Older change/);
    step('comment labels (nit: → **nit:**), next unresolved thread, line history hover (blame → MR !5)');

    // Since your review: mark reviewed, author pushes a change to math.ts only, refresh → only math.ts, diffed vs reviewed.
    await vscode.commands.executeCommand('ripple.markReviewed');
    assert.equal(s.state.reviewed?.headSha, headSha);
    const g = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo }).toString().trim();
    writeFileSync(path.join(repo, 'src/math.ts'), 'export function add(a: number, b: number): number {\n  return b + a;\n}\n');
    g('commit', '-qam', 'address review');
    const newHead = g('rev-parse', 'HEAD');
    g('update-ref', 'refs/merge-requests/1/head', newHead);
    gl.setHead(newHead);
    await vscode.commands.executeCommand('ripple.refresh');
    await waitFor(() => s.refs.head_sha === newHead && s.since, 'refresh picks up the push');
    assert.deepEqual([...s.since!.files], ['src/math.ts']);
    await vscode.commands.executeCommand('ripple.toggleSinceReview');
    assert.deepEqual(s.visibleFiles().map((f) => f.path), ['src/math.ts']);
    const { diffUris } = await import('../../src/ui/diff');
    assert.equal(new URLSearchParams(diffUris(s, s.fileByPath('src/math.ts')!).left.query).get('ref'), headSha, 'diff vs the reviewed version');
    step('since your review: only files the author changed after your review, diffed against the reviewed version');

    const pause = Number(process.env.BR_E2E_PAUSE_MS ?? 0);
    if (pause) {
      await vscode.commands.executeCommand('workbench.view.extension.ripple');
      await vscode.commands.executeCommand('ripple.openFile', 'src/app.service.ts');
      await new Promise((r) => setTimeout(r, pause));
    }
  } finally {
    await gl.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function pick(p: any) {
  return { new_path: p.new_path, old_path: p.old_path, new_line: p.new_line, old_line: p.old_line, base_sha: p.base_sha, head_sha: p.head_sha };
}

async function waitFor<T>(fn: () => T | Promise<T>, what: string, timeout = 15_000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function makeRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir }).toString().trim();
  const write = (p: string, c: string) => {
    mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    writeFileSync(path.join(dir, p), c);
  };
  const service = (extra: string[], sum3Body: string[]) =>
    [
      "import { add } from './math';",
      ...extra,
      ...Array.from({ length: 10 }, (_, i) => `// line ${i}`),
      'export const total = add(1, 2);',
      'export function sum3(a: number, b: number, c: number) {',
      ...sum3Body,
      '}',
      '',
    ].join('\n');

  git('init', '-q', '-b', 'main');
  write('tsconfig.json', '{ "compilerOptions": { "strict": true, "jsx": "preserve" } }\n');
  write('src/math.ts', 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
  write('src/app.service.ts', service(['', ''], ['  return add(add(a, b), c);']));
  write(
    'src/order.controller.ts',
    [
      "import { sum3 } from './app.service';",
      'const Controller = (_p: string) => (_t: unknown) => undefined;',
      'const Get = (_p?: string) => (_t: unknown, _c: unknown) => undefined;',
      "@Controller('orders')",
      'export class OrderController {',
      "  @Get(':id/total')",
      '  handle() {',
      '    return sum3(1, 2, 3);',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  // Frontend: an RTK Query endpoint for that route, a component using its hook, a page rendering the component.
  write(
    'src/web/orderApi.ts',
    [
      'declare const createApi: any;',
      'declare const fetchBaseQuery: any;',
      'declare const ORDERS_SERVICE_URL: string;',
      'export const orderApi = createApi({',
      '  baseQuery: fetchBaseQuery({ baseUrl: ORDERS_SERVICE_URL }),',
      '  endpoints: (build: any) => ({',
      '    getOrderTotal: build.query({ query: (id: string) => `orders/${id}/total` }),',
      '  }),',
      '});',
      'export const { useGetOrderTotalQuery } = orderApi;',
      '',
    ].join('\n'),
  );
  write(
    'src/web/OrderTotal.tsx',
    [
      "import { useGetOrderTotalQuery } from './orderApi';",
      'declare global {',
      '  namespace JSX {',
      '    interface IntrinsicElements { [k: string]: any }',
      '  }',
      '}',
      'export function OrderTotal({ id }: { id: string }) {',
      '  const { data } = useGetOrderTotalQuery(id);',
      '  return <b>{data}</b>;',
      '}',
      'export function OrderPage() {',
      '  return <OrderTotal id="1" />;',
      '}',
      '',
    ].join('\n'),
  );
  write('src/format.ts', 'const a = 1;\n');
  write('src/legacy.ts', 'export const legacy = true;\n');
  write('package-lock.json', '{}\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const baseSha = git('rev-parse', 'HEAD');

  git('checkout', '-q', '-b', 'feature');
  write('src/math.ts', 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
  write('src/app.service.ts', service(['', '', 'export const pageSize = 20;'], ['  const ab = add(a, b);', '  return add(ab, c);']));
  write('src/format.ts', 'const a  =  1;\n');
  write('src/order.dto.ts', 'export class OrderDto {\n  page!: number;\n}\n');
  rmSync(path.join(dir, 'src/legacy.ts'));
  write('package-lock.json', '{ "lockfileVersion": 3 }\n');
  git('add', '-A');
  git('commit', '-qm', 'feature');
  const headSha = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/merge-requests/1/head', headSha);

  return { repo: dir, baseSha, headSha };
}
