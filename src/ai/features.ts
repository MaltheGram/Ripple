import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ChangedFile } from '../core/types';
import type { CommentsController } from '../ui/comments';
import { locate } from '../ui/diff';
import { readWorktreeFileSync } from '../repo/safeRead';
import type { ReviewSession } from '../ui/session';
import { type AiAnalysis, analysisMarkdown, analyzeMr, prepareAnalysis } from './analysis';
import { formatTokens, requireClaude, runClaude } from './claude';
import { type AiOptions, DEPTHS, describeOptions, FOCUS, loadOptions, optionsKey, pickOptions } from './options';
import { annotatedDiff, numberedFile, REVIEWER_SYSTEM, SUGGEST_SCHEMA, suggestPrompt, tokensToChars } from './prompts';

// ── one run per (MR version, target, options) ─────────────────────────────

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Every AI action goes through here. A result is generated at most once per key (the key includes the MR
 * version and the options); later clicks get the stored result, and clicks while it runs join that run.
 * Results live in the session's memory, so reloading the window or new commits allow a fresh run.
 */
export async function once<T>(s: ReviewSession, key: string, run: () => Promise<T>): Promise<{ value: T; reused: boolean }> {
  const full = `${s.refs.head_sha}|${key}`;
  if (s.aiCache.has(full)) return { value: s.aiCache.get(full) as T, reused: true };
  const running = inFlight.get(full) as Promise<T> | undefined;
  if (running) {
    void vscode.window.showInformationMessage('Already running. The result will show when it is ready.');
    return { value: await running, reused: true };
  }
  const p = run();
  inFlight.set(full, p);
  try {
    const value = await p;
    s.aiCache.set(full, value);
    return { value, reused: false };
  } finally {
    inFlight.delete(full);
  }
}

// ── AI review ──────────────────────────────────────────────────────────────

/**
 * Generate the AI review. If one exists for this MR version it is shown instead (no new call); the user
 * can change options, which allows a run for the new options. `preset` skips the options menu (tests).
 */
export async function runAnalysis(s: ReviewSession, context: vscode.ExtensionContext, preset?: AiOptions) {
  if (s.ai && !preset) {
    await s.updateFilters({ groupBy: 'ai' });
    await vscode.commands.executeCommand('ripple.openOverview');
    const choice = await vscode.window.showInformationMessage(
      `AI review already generated for this MR version (${describeOptions(s.ai.options)}). ` +
        'It regenerates only after new commits or with different options.',
      'Different Options…',
    );
    if (choice) return pickAndRun(s, context);
    return;
  }
  if (preset) return generate(s, preset);
  return pickAndRun(s, context);
}

async function pickAndRun(s: ReviewSession, context: vscode.ExtensionContext) {
  await requireClaude();
  const o = await pickOptions(context, `Generate AI review for !${s.entry.iid}`, (opts) => {
    const p = prepareAnalysis(s, opts);
    return { tokens: p.tokens, files: p.files.filter((f) => !f.trivial).length, omitted: p.omitted.length };
  });
  if (o) await generate(s, o);
}

async function generate(s: ReviewSession, o: AiOptions) {
  const prepared = prepareAnalysis(s, o);
  const { value: a, reused } = await once<AiAnalysis>(s, `review:${optionsKey(o)}`, () =>
    Promise.resolve(
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `AI review of !${s.entry.iid} (${describeOptions(o)}, ~${formatTokens(prepared.tokens)} tokens)…`,
          cancellable: true,
        },
        (_, cancel) => analyzeMr(s, prepared, o, cancel),
      ),
    ),
  );
  s.setAi(a);
  await s.updateFilters({ groupBy: 'ai', focusGroup: undefined });
  const high = a.risks.filter((r) => r.severity === 'high').length;
  void vscode.window
    .showInformationMessage(
      `${reused ? 'Showing the existing AI review for these options' : 'AI review ready'}: ${a.groups.length} review units, ` +
        `${a.risks.length} risk hotspots${high ? ` (${high} high)` : ''}.` +
        (a.omitted.length ? ` ${a.omitted.length} large files were left out (max tokens).` : ''),
      'Open Summary',
    )
    .then((choice) => choice && vscode.commands.executeCommand('ripple.openOverview'));
}

/** Change the AI defaults without running anything. */
export async function editOptions(context: vscode.ExtensionContext) {
  await pickOptions(context, 'Save these options', () => ({ tokens: 0, files: 0, omitted: 0 }));
}

export async function postSummary(s: ReviewSession) {
  if (!s.ai) throw new Error('Generate the AI review first.');
  const ok = await vscode.window.showInformationMessage(
    `Post the AI summary as a comment on !${s.entry.iid}?`,
    { modal: true, detail: 'Everyone on the merge request will see it.' },
    'Post',
  );
  if (!ok) return;
  await s.client.createDiscussion(s.entry.projectId, s.entry.iid, analysisMarkdown(s.ai, true));
  await s.reloadComments();
  void vscode.window.showInformationMessage('AI summary posted.');
}

// ── suggest comments ───────────────────────────────────────────────────────

type Suggestions = { comments: { line: number; severity: string; body: string }[] };

/** Ask Claude for review comments on the current file; they appear inline to accept or discard. Uses the saved AI options. */
export async function suggestComments(s: ReviewSession, context: vscode.ExtensionContext, comments: CommentsController) {
  await requireClaude();
  const editor = vscode.window.activeTextEditor;
  const loc = editor && locate(s, editor.document.uri);
  if (!editor || !loc) throw new Error('Open a file of this MR first.');
  if (loc.file.change === 'deleted') throw new Error('Suggestions need a new version of the file; this one is deleted.');
  const file = loc.file;
  const text = readWorktreeFileSync(s.entry.worktree, file.path);
  if (text === undefined) throw new Error(`${file.path} can't be read safely (symlink or outside the checkout).`);
  const lines = text.split('\n');
  const o = loadOptions(context);

  const { value, reused } = await once<Suggestions>(s, `suggest:${file.path}:${optionsKey(o)}`, () =>
    Promise.resolve(
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Claude is reviewing ${file.path.split('/').pop()} (${o.model}, ${DEPTHS[o.depth].label.toLowerCase()})…`, cancellable: true },
        (_, cancel) =>
          runClaude<Suggestions>({
            prompt: suggestPrompt(s.mr.title, file.path, fileBody(file, lines, o), o.focus.map((f) => FOCUS[f]), o.depth === 'deep'),
            system: REVIEWER_SYSTEM,
            schema: SUGGEST_SCHEMA,
            model: o.model,
            label: 'suggest comments',
            cancel,
            deep: o.depth === 'deep' ? { cwd: s.entry.worktree, maxTokens: o.maxTokens } : undefined,
          }),
      ),
    ),
  );
  const valid = value.comments.filter((c) => c.line >= 1 && c.line <= lines.length);
  comments.showSuggestions(s, file, valid);
  void vscode.window.showInformationMessage(
    (valid.length
      ? `${valid.length} AI suggestion${valid.length === 1 ? '' : 's'} shown inline. ✓ adds one as your draft, 🗑 discards it.`
      : 'Claude has no comments on this file.') + (reused ? ' (Already generated for this MR version; no new Claude call.)' : ''),
  );
}

/** The file as Claude sees it for suggestions, by depth. Numbered new lines so answers map to lines. */
function fileBody(f: ChangedFile, lines: string[], o: AiOptions): string {
  const cap = Math.min(tokensToChars(o.maxTokens), 60_000);
  if (o.depth === 'diff') return annotatedDiff(f.hunks, lines, 2, cap);
  if (o.depth === 'full') return `${numberedFile(lines, Math.floor(cap * 0.7))}\n\n--- changes in this MR (annotated) ---\n${annotatedDiff(f.hunks, lines, 0, Math.floor(cap * 0.3))}`;
  return annotatedDiff(f.hunks, lines, 6, cap);
}

function numbered(doc: vscode.TextDocument, first: number, last: number): string {
  const out: string[] = [];
  for (let l = first; l <= last; l++) out.push(`${String(l + 1).padStart(5)}  ${doc.lineAt(l).text}`);
  return out.join('\n');
}
