import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { changedDependencies, identifiers, textDependencies, type ChangedDependency, type Definition } from '../core/deps';
import { positionForOldLine } from '../core/lineMap';
import type { ChangedFile, Hunk } from '../core/types';
import { readWorktreeFileSync } from '../repo/safeRead';
import { positionForLines } from '../ui/comments';
import { GIT_SCHEME, gitUriRef, revealInDiff } from '../ui/diff';
import type { ReviewSession } from '../ui/session';
import { requireClaude, runClaude } from './claude';
import { once } from './features';
import { FOCUS, loadOptions, optionsKey } from './options';
import { EXPLAIN_SCHEMA, explainPrompt, FOLLOWUP_SCHEMA, followUpPrompt, REVIEWER_SYSTEM, unifiedDiff } from './prompts';

const MAX_LINES = 250;
const MAX_FILE_LINES = 500;
const MAX_DEPENDENCIES = 10;
const MAX_CALLERS = 6;

export interface Explanation {
  verdict: 'changed' | 'affected' | 'unaffected' | 'unclear';
  summary: string;
  effects: { kind: string; description: string; cause: { file: string; line: number | null; symbol: string | null } }[];
  checks: string[];
}

export interface ExplainTarget {
  /** Worktree-relative path (old path on the old side). */
  rel: string;
  side: 'new' | 'old';
  /** The MR file, when the selection is in one. */
  file?: ChangedFile;
  /** 0-based inclusive lines. */
  first: number;
  last: number;
  label: string;
}

export interface GatheredDep {
  name: string;
  path: string;
  line: number;
  how: 'definition' | 'type' | 'text match';
}

export interface ExplainResult {
  /** Cache key of this explanation; follow-ups are keyed under it. */
  key: string;
  /** The prompt Claude answered, reused as context for follow-up questions. */
  prompt: string;
  target: ExplainTarget;
  answer: Explanation;
  followUps: { question: string; answer: string }[];
  ownChanges: number;
  dependencies: GatheredDep[];
  callers: number;
  model: string;
  reused: boolean;
}

/**
 * Explain how the MR affects the selected code (or, without a selection, the function/class at the cursor).
 * New side of a diff, old side (what happened to the code), and any file of the MR checkout.
 * Context comes from the language server and the diff; Claude only reasons about it.
 */
export async function explainSelection(
  s: ReviewSession,
  context: vscode.ExtensionContext,
  { wholeFile = false } = {},
): Promise<ExplainResult> {
  await requireClaude();
  const editor = vscode.window.activeTextEditor;
  if (!editor) throw new Error('Open a file and select the code to explain.');
  const doc = editor.document;
  const where = locateDoc(s, doc.uri);
  // A symlink in the checkout could show (and send) a file from outside it.
  if (where.side === 'new' && readWorktreeFileSync(s.entry.worktree, where.rel) === undefined) {
    throw new Error(`${where.rel} can't be explained: it is a symlink or resolves outside the MR checkout.`);
  }
  const { range, label, symbol } = wholeFile
    ? { range: new vscode.Range(0, 0, doc.lineCount - 1, 0), label: `${path.posix.basename(where.rel)} (whole file)`, symbol: undefined }
    : await pickRange(editor, where.side === 'new');
  const first = range.start.line;
  const last = Math.min(range.end.line, first + (wholeFile ? MAX_FILE_LINES : MAX_LINES) - 1, doc.lineCount - 1);
  const target: ExplainTarget = { ...where, first, last, label };
  const text = doc.getText(new vscode.Range(first, 0, last, doc.lineAt(last).text.length));
  const o = loadOptions(context);
  const key = `explain:${where.side}:${where.rel}:${first}-${last}:${createHash('sha1').update(text).digest('hex').slice(0, 12)}:${optionsKey(o)}`;

  const { value, reused } = await once<Omit<ExplainResult, 'reused' | 'followUps'>>(s, key, () =>
    Promise.resolve(
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Explaining ${label} against !${s.entry.iid}…`, cancellable: true },
        async (progress, cancel) => {
          progress.report({ message: 'finding related changes…' });
          const file = where.file;
          const ownHunks = (file?.hunks ?? []).filter((h) => (where.side === 'new' ? overlapsNew : overlapsOld)(h, first + 1, last + 1));

          // New side: ask the language server. Old side is a virtual document without one → text match.
          let deps = where.side === 'new' ? await languageDeps(s, doc, first, last, text, wholeFile ? 60 : 40) : [];
          if (!deps.length) {
            deps = textDependencies(
              identifiers(text).map((i) => i.name),
              s.files.filter((f) => f.change !== 'deleted'),
              where.side === 'new' ? where.rel : undefined,
              MAX_DEPENDENCIES,
            ).map((d) => ({ ...d, how: 'text match' as const }));
          }
          const callers = where.side === 'new' && ownHunks.length && symbol ? await callersOf(s, doc.uri, symbol.selectionRange.start) : [];
          const movedTo =
            where.side === 'old' && file && file.change !== 'deleted' ? positionForOldLine(file.hunks, first + 1).new_line : undefined;

          progress.report({ message: `asking Claude (${o.model})…` });
          const prompt = explainPrompt({
              mrTitle: s.mr.title,
              mrSummary: s.ai?.summary,
              path: where.rel,
              inMr: !!file,
              side: where.side,
              note: movedTo ? `In the new version this code starts around line ${movedTo}.` : undefined,
              target: label,
              code: numbered(doc, first, last),
              ownDiff: unifiedDiff({ hunks: ownHunks }, 12_000),
              dependencies: deps.map((d) => ({ name: d.name, path: d.path, lines: `${d.startLine}-${d.endLine}`, how: d.how, diff: unifiedDiff(d, 4_000) })),
              callers,
              focus: o.focus.map((f) => FOCUS[f]),
              deep: o.depth === 'deep',
              wholeFile,
            });
          const answer = await runClaude<Explanation>({
            prompt,
            system: REVIEWER_SYSTEM,
            schema: EXPLAIN_SCHEMA,
            model: o.model,
            label: 'explain selection',
            cancel,
            deep: o.depth === 'deep' ? { cwd: s.entry.worktree, maxTokens: o.maxTokens } : undefined,
          });
          return {
            key,
            prompt,
            target,
            answer,
            ownChanges: ownHunks.length,
            dependencies: deps.map((d) => ({ name: d.name, path: d.path, line: d.startLine, how: d.how })),
            callers: callers.length,
            model: o.model,
          };
        },
      ),
    ),
  );
  // Follow-ups live on the cached value so they survive re-opening the same explanation.
  const cached = value as ExplainResult;
  cached.followUps ??= [];
  return Object.assign(cached, { reused });
}

/** Ask a follow-up about an explanation, reusing its context. One answer per question per explanation. */
export async function askFollowUp(s: ReviewSession, context: vscode.ExtensionContext, r: ExplainResult, question: string): Promise<string> {
  await requireClaude();
  const q = question.trim();
  if (!q) throw new Error('Type a question first.');
  const o = loadOptions(context);
  const { value } = await once<string>(s, `${r.key}:followup:${createHash('sha1').update(q).digest('hex').slice(0, 12)}`, () =>
    Promise.resolve(
      vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Claude: ${q.slice(0, 40)}…`, cancellable: true }, async (_, cancel) => {
        const res = await runClaude<{ markdown: string }>({
          prompt: followUpPrompt(r, q),
          system: REVIEWER_SYSTEM,
          schema: FOLLOWUP_SCHEMA,
          model: o.model,
          label: 'explain follow-up',
          cancel,
          deep: o.depth === 'deep' ? { cwd: s.entry.worktree, maxTokens: o.maxTokens } : undefined,
        });
        return res.markdown;
      }),
    ),
  );
  if (!r.followUps.some((f) => f.question === q)) r.followUps.push({ question: q, answer: value });
  return value;
}

/** Turn (part of) an explanation into a GitLab draft on the selected lines, or a general draft when outside the MR. */
export async function explanationToDraft(s: ReviewSession, r: ExplainResult, what: 'all' | 'effect' | 'check', index = 0): Promise<string> {
  const a = r.answer;
  const cause = (e: Explanation['effects'][number]) => `\`${e.cause.file}${e.cause.line ? `:${e.cause.line}` : ''}\``;
  let body: string;
  if (what === 'effect') {
    const e = a.effects[index];
    body = `**${e.kind}**: ${e.description}\n\nCaused by ${cause(e)}${e.cause.symbol ? ` (\`${e.cause.symbol}\`)` : ''}.`;
  } else if (what === 'check') {
    body = `Could you check: ${a.checks[index]}`;
  } else {
    body = [a.summary, ...a.effects.map((e) => `- **${e.kind}**: ${e.description} (${cause(e)})`), ...(a.checks.length ? ['', 'To check:', ...a.checks.map((c) => `- [ ] ${c}`)] : [])].join('\n');
  }

  const t = r.target;
  const { projectId, iid } = s.entry;
  if (t.file) {
    await s.client.createDraft(projectId, iid, { note: body, position: positionForLines(s, t.file, t.side, t.first + 1, t.last + 1) });
  } else {
    await s.client.createDraft(projectId, iid, { note: `\`${t.rel}:${t.first + 1}-${t.last + 1}\` (not changed in this MR)\n\n${body}` });
  }
  await s.reloadComments();
  return t.file ? 'Added as a draft comment on the selected lines.' : 'Added as a general draft comment (the file is not part of the MR).';
}

/** Jump to a cause: the diff if the file is in the MR, else the file in the checkout. */
export async function openCause(s: ReviewSession, file: string, line: number | null) {
  const f = s.fileByPath(file);
  if (f && f.change !== 'deleted') return revealInDiff(s, f, line ?? 1);
  const pos = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(s.entry.worktree, file)), { selection: new vscode.Range(pos, pos), viewColumn: vscode.ViewColumn.One });
}

function locateDoc(s: ReviewSession, uri: vscode.Uri): Pick<ExplainTarget, 'rel' | 'side' | 'file'> {
  if (uri.scheme === GIT_SCHEME) {
    if (gitUriRef(uri) !== s.refs.base_sha) throw new Error('This document is not part of the current MR version.');
    const rel = uri.path.slice(1);
    return { rel, side: 'old', file: s.files.find((f) => f.oldPath === rel && f.change !== 'added') };
  }
  const rel = path.relative(s.entry.worktree, uri.fsPath).split(path.sep).join('/');
  if (uri.scheme !== 'file' || rel.startsWith('..')) {
    throw new Error('Explain works on files of the MR checkout (open them from the Review list or via go-to-definition).');
  }
  return { rel, side: 'new', file: s.files.find((f) => f.path === rel && f.change !== 'deleted') };
}

/** Selection (whole lines), else the smallest function/class/method at the cursor, else ±15 lines. */
async function pickRange(editor: vscode.TextEditor, useSymbols: boolean): Promise<{ range: vscode.Range; label: string; symbol?: vscode.DocumentSymbol }> {
  const doc = editor.document;
  if (!editor.selection.isEmpty) {
    const r = editor.selection;
    const endLine = r.end.character === 0 && r.end.line > r.start.line ? r.end.line - 1 : r.end.line;
    const symbol = useSymbols ? (await symbolsAt(doc, r.start)).at(-1) : undefined;
    return { range: new vscode.Range(r.start.line, 0, endLine, 0), label: `lines ${r.start.line + 1}-${endLine + 1}`, symbol };
  }
  const chain = useSymbols ? await symbolsAt(doc, editor.selection.active) : [];
  const symbol = chain.at(-1);
  if (symbol) {
    const container = chain.at(-2);
    return { range: symbol.range, label: container ? `${container.name}.${symbol.name}` : symbol.name, symbol };
  }
  const l = editor.selection.active.line;
  return { range: new vscode.Range(Math.max(0, l - 15), 0, Math.min(doc.lineCount - 1, l + 15), 0), label: `lines ${Math.max(1, l - 14)}-${l + 16}` };
}

/** Document symbols containing `pos`, outermost first. */
async function symbolsAt(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.DocumentSymbol[]> {
  const roots = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri);
  const chain: vscode.DocumentSymbol[] = [];
  let level = roots && 'children' in (roots[0] ?? {}) ? roots : [];
  for (;;) {
    const hit = level.find((sym) => sym.range.contains(pos));
    if (!hit) return chain;
    chain.push(hit);
    level = hit.children;
  }
}

type Dep = ChangedDependency & { how: GatheredDep['how'] };

/** Definitions and type definitions of identifiers in the selection that this MR changed. */
async function languageDeps(s: ReviewSession, doc: vscode.TextDocument, first: number, last: number, text: string, maxIds = 40): Promise<Dep[]> {
  const base = doc.offsetAt(new vscode.Position(first, 0));
  const root = s.entry.worktree + path.sep;
  const found: { def: Definition; how: 'definition' | 'type' }[] = [];
  const collect = (locs: (vscode.Location | vscode.LocationLink)[] | undefined, name: string, how: 'definition' | 'type') => {
    for (const loc of locs ?? []) {
      const uri = 'targetUri' in loc ? loc.targetUri : loc.uri;
      const r = 'targetRange' in loc ? loc.targetRange : loc.range;
      if (uri.scheme !== 'file' || !uri.fsPath.startsWith(root) || uri.fsPath.includes(`${path.sep}node_modules${path.sep}`)) continue;
      // Defined inside the selection itself: not a dependency.
      if (uri.fsPath === doc.uri.fsPath && r.start.line >= first && r.end.line <= last) continue;
      found.push({ def: { name, path: path.relative(s.entry.worktree, uri.fsPath).split(path.sep).join('/'), startLine: r.start.line + 1, endLine: r.end.line + 1 }, how });
    }
  };
  await pool(identifiers(text, maxIds), 8, async ({ name, offset }) => {
    const pos = doc.positionAt(base + offset);
    const [defs, types] = await Promise.all([
      vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', doc.uri, pos),
      vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeTypeDefinitionProvider', doc.uri, pos),
    ]);
    collect(defs, name, 'definition');
    collect(types, name, 'type');
  });
  const hunksByPath = new Map<string, Hunk[]>(s.files.filter((f) => f.change !== 'deleted').map((f) => [f.path, f.hunks]));
  const how = new Map(found.map((f) => [`${f.def.path}:${f.def.startLine}`, f.how]));
  // Definitions first, so a symbol found both ways is labelled "definition".
  const ordered = [...found.filter((f) => f.how === 'definition'), ...found.filter((f) => f.how === 'type')].map((f) => f.def);
  return changedDependencies(ordered, hunksByPath)
    .slice(0, MAX_DEPENDENCIES)
    .map((d) => ({ ...d, how: how.get(`${d.path}:${d.startLine}`) ?? 'definition' }));
}

async function callersOf(s: ReviewSession, uri: vscode.Uri, pos: vscode.Position) {
  const [item] = (await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', uri, pos)) ?? [];
  if (!item) return [];
  const calls = (await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', item)) ?? [];
  const root = s.entry.worktree + path.sep;
  // Only code from the checkout goes to Claude (not node_modules or anything a link resolves to).
  const inRepo = calls.filter((c) => c.from.uri.scheme === 'file' && c.from.uri.fsPath.startsWith(root) && !c.from.uri.fsPath.includes(`${path.sep}node_modules${path.sep}`));
  return Promise.all(
    inRepo.slice(0, MAX_CALLERS).map(async (c) => {
      const d = await vscode.workspace.openTextDocument(c.from.uri);
      const l = (c.fromRanges[0] ?? c.from.selectionRange).start.line;
      return { label: c.from.name, path: path.relative(s.entry.worktree, c.from.uri.fsPath), snippet: numbered(d, Math.max(0, l - 3), Math.min(d.lineCount - 1, l + 3)) };
    }),
  );
}

function overlapsNew(h: Hunk, startLine: number, endLine: number): boolean {
  const start = h.newLines > 0 ? h.newStart : h.newStart + 1;
  const end = h.newLines > 0 ? h.newStart + h.newLines - 1 : h.newStart + 1;
  return end >= startLine && start <= endLine;
}

function overlapsOld(h: Hunk, startLine: number, endLine: number): boolean {
  const start = h.oldLines > 0 ? h.oldStart : h.oldStart + 1;
  const end = h.oldLines > 0 ? h.oldStart + h.oldLines - 1 : h.oldStart + 1;
  return end >= startLine && start <= endLine;
}

function numbered(doc: vscode.TextDocument, first: number, last: number): string {
  const out: string[] = [];
  for (let l = first; l <= last; l++) out.push(`${String(l + 1).padStart(5)}  ${doc.lineAt(l).text}`);
  return out.join('\n');
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]).catch(() => undefined);
    }),
  );
}
