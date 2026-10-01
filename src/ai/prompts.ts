import type { ChangedFile, Hunk } from '../core/types';

// Pure prompt builders (no vscode) so budgets and formats are easy to test.

export const REVIEWER_SYSTEM =
  'You are a senior software engineer helping a colleague review a GitLab merge request. ' +
  'Be concrete, specific and brief. Refer to files by their exact path. Write plain, clear English. ' +
  'Never invent code that is not in the input.';

/** Default diff budget; the real one comes from `ripple.ai.maxInputTokens`. */
export const MAX_DIFF_CHARS = 100_000;
/** One huge file shouldn't eat the budget of the rest. */
const MAX_FILE_CHARS = 6_000;

/** Rough token estimate for code/markdown (≈3.5 chars per token). Good enough for a "this is big" warning. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function tokensToChars(tokens: number): number {
  return Math.floor(tokens * 3.5);
}

export interface MrInfo {
  iid: number;
  title: string;
  description?: string;
  source_branch: string;
  target_branch: string;
}

const CHANGE_LETTER = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' } as const;

export interface AnalysisPrompt {
  prompt: string;
  /** Substantive files whose diff didn't fit the budget. */
  omitted: string[];
}

export interface AnalysisPromptOptions {
  /** Total character budget for per-file content. */
  maxChars: number;
  /** Content for one file (diff, diff with context, or full file) within `cap` chars. */
  render: (f: ChangedFile, cap: number) => string;
  /** Per-file cap; one huge file shouldn't eat the budget of the rest. */
  perFileCap?: number;
  includeTests?: boolean;
  focus?: string[];
  /** Claude may read other repository files with read-only tools. */
  deep?: boolean;
}

export function analysisPrompt(mr: MrInfo, files: ChangedFile[], o: AnalysisPromptOptions): AnalysisPrompt {
  const substantive = files.filter((f) => !f.trivial).sort((a, b) => a.role - b.role || a.path.localeCompare(b.path));
  const list = files.map((f) => {
    const name = f.change === 'renamed' ? `${f.oldPath} → ${f.path}` : f.path;
    const size = f.binary ? 'binary' : `+${f.additions} −${f.deletions}`;
    return `- ${CHANGE_LETTER[f.change]} ${name} (${size})${f.trivial ? ` [trivial: ${f.trivial}]` : ''}`;
  });

  let budget = o.maxChars;
  const blocks: string[] = [];
  const omitted: string[] = [];
  const skippedTests: string[] = [];
  for (const f of substantive) {
    if (f.binary) continue;
    if (o.includeTests === false && f.isTest) {
      skippedTests.push(f.path);
      continue;
    }
    const body = o.render(f, o.perFileCap ?? MAX_FILE_CHARS);
    if (body.length > budget) {
      omitted.push(f.path);
      continue;
    }
    budget -= body.length;
    blocks.push(`### ${f.path} (${f.change})\n\`\`\`\n${body}\n\`\`\``);
  }

  const prompt = [
    `# Merge request !${mr.iid}: ${mr.title}`,
    `Branch: ${mr.source_branch} → ${mr.target_branch}`,
    '',
    '## Description',
    mr.description?.trim() || '(none)',
    '',
    `## Changed files (${files.length}; ${substantive.length} substantive)`,
    ...list,
    '',
    '## Code of substantive files',
    omitted.length ? `(Left out for size: ${omitted.join(', ')})` : '',
    skippedTests.length ? `(Test files left out on request: ${skippedTests.length})` : '',
    ...blocks,
    '',
    '## Task',
    '1. summary: 3-6 markdown bullet points: what the MR does and why, the main changes, and anything surprising or risky.',
    '2. groups: split ALL substantive files into review units (one feature, layer or concern each, usually 2-15 files). ' +
      'Order the groups so a reviewer builds understanding step by step: contracts/types/schema first, then core logic, then entry points (controllers, handlers, UI), then tests. ' +
      'Every substantive file must be in exactly one group. Use the exact paths from the file list. Give each group a short title and a one-sentence "why".',
    '3. risks: up to 15 specific places a reviewer should look at closely: auth/permissions, money/billing, data migrations, concurrency, error handling, security, performance, breaking API changes, missing tests. ' +
      'Use the exact path and the new-file line number when you can (null otherwise). No style nits.',
    focusLine(o.focus),
    o.deep ? DEEP_NOTE : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
  return { prompt, omitted };
}

export const DEEP_NOTE =
  'You may use the Read, Grep and Glob tools to look at other files in this repository (callers, definitions, similar code, conventions) ' +
  'when the code above is not enough to judge a change. Be economical: only open what you need.';

export function focusLine(focus?: string[]): string {
  return focus?.length ? `Pay extra attention to: ${focus.join('; ')}.` : '';
}

export const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Markdown bullet list' },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          why: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'why', 'files'],
      },
    },
    risks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: ['integer', 'null'] },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          category: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['file', 'line', 'severity', 'category', 'note'],
      },
    },
  },
  required: ['summary', 'groups', 'risks'],
} as const;

export interface ExplainInput {
  mrTitle: string;
  /** AI review summary if one exists already (no extra call). */
  mrSummary?: string;
  path: string;
  /** Whether the file is part of the MR at all. */
  inMr: boolean;
  /** 'old' = the selection is from the version before the MR. */
  side?: 'new' | 'old';
  /** Extra hint, e.g. where old code lives now. */
  note?: string;
  /** e.g. "OrderController.handle" or "lines 12-30". */
  target: string;
  /** Selected code, numbered with new-file line numbers. */
  code: string;
  /** Changes of this MR inside the selection (unified diff), or empty. */
  ownDiff: string;
  /** Functions/types the selection uses that this MR changed. */
  dependencies: { name: string; path: string; lines: string; diff: string; how?: string }[];
  callers: { label: string; path: string; snippet: string }[];
  focus?: string[];
  deep?: boolean;
  /** The selection is the whole file. */
  wholeFile?: boolean;
}

export function explainPrompt(i: ExplainInput): string {
  return [
    `Merge request: ${i.mrTitle}`,
    i.mrSummary ? `\nMR summary:\n${i.mrSummary}` : '',
    '',
    `## Selected code: ${i.target}`,
    `File: ${i.path}${i.inMr ? '' : ' (this file is NOT changed by the MR)'}`,
    i.side === 'old' ? 'This is the OLD version of the code, from before the MR. Line numbers are old-file line numbers.' : '',
    i.note ?? '',
    '```',
    i.code,
    '```',
    '',
    '## Changes of this MR inside the selection',
    i.ownDiff ? `\`\`\`diff\n${i.ownDiff}\n\`\`\`` : '(none: the selected code itself did not change)',
    '',
    '## Code the selection uses that this MR changed',
    ...(i.dependencies.length
      ? i.dependencies.map((d) => `### ${d.name} (${d.path}:${d.lines})${d.how === 'text match' ? ' [approximate: name match, not a verified reference]' : d.how === 'type' ? ' [type]' : ''}\n\`\`\`diff\n${d.diff}\n\`\`\``)
      : ['(none found)']),
    '',
    '## Callers of the selected code',
    ...(i.callers.length ? i.callers.map((c) => `### ${c.label} (${c.path})\n\`\`\`\n${c.snippet}\n\`\`\``) : ['(none found or not relevant)']),
    '',
    '## Task',
    (i.side === 'old' ? 'Explain what this merge request did to the selected OLD code (removed, moved, rewritten, kept) and what that means. ' : '') +
      (i.wholeFile ? 'The selection is the WHOLE FILE: give a file-level picture of what the MR does to it and through it. ' : '') +
      'Explain to a code reviewer how this merge request affects the selected code. Distinguish what changed IN the selection from what affects it ' +
      'THROUGH the code it uses (listed above). Every effect must name its cause as a file and new-file line from the input. ' +
      'If nothing in the MR affects it, say so plainly with verdict "unaffected". ' +
      'verdict: "changed" if the selection itself changed, else "affected" if changed dependencies alter its behavior, types or data, else "unaffected"; use "unclear" only when the input is not enough. ' +
      'summary: 2-4 sentences. effects: at most 6. checks: at most 5 concrete things the reviewer should verify.',
    focusLine(i.focus),
    i.deep ? DEEP_NOTE : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export interface FollowUpContext {
  prompt: string;
  answer: { verdict: string; summary: string; effects: { kind: string; description: string; cause: { file: string; line: number | null } }[]; checks: string[] };
  followUps: { question: string; answer: string }[];
}

/** Follow-up question on an explanation: same context, the earlier answer and Q&A, then the new question. */
export function followUpPrompt(r: FollowUpContext, question: string): string {
  const a = r.answer;
  return [
    r.prompt,
    '',
    '## Your earlier explanation',
    `Verdict: ${a.verdict}. ${a.summary}`,
    ...a.effects.map((e) => `- ${e.kind}: ${e.description} (cause ${e.cause.file}${e.cause.line ? `:${e.cause.line}` : ''})`),
    ...r.followUps.flatMap((f) => ['', `## Earlier question: ${f.question}`, f.answer]),
    '',
    `## Follow-up question from the reviewer`,
    question,
    '',
    'Answer the follow-up concisely in markdown (under 200 words). Refer to code as `path:line` from the input. If the input is not enough to answer, say what is missing.',
  ].join('\n');
}

export const FOLLOWUP_SCHEMA = {
  type: 'object',
  properties: { markdown: { type: 'string' } },
  required: ['markdown'],
} as const;

export const EXPLAIN_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['changed', 'affected', 'unaffected', 'unclear'] },
    summary: { type: 'string' },
    effects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['behavior', 'signature', 'type', 'data', 'error-handling', 'performance', 'other'] },
          description: { type: 'string' },
          cause: {
            type: 'object',
            properties: { file: { type: 'string' }, line: { type: ['integer', 'null'] }, symbol: { type: ['string', 'null'] } },
            required: ['file', 'line', 'symbol'],
          },
        },
        required: ['kind', 'description', 'cause'],
      },
    },
    checks: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'summary', 'effects', 'checks'],
} as const;

export function suggestPrompt(mrTitle: string, path: string, annotatedDiff: string, focus?: string[], deep?: boolean): string {
  return [
    `Merge request: ${mrTitle}`,
    `File: ${path}`,
    '',
    'Diff with context. Each line is "<new line number or blank> <marker> <code>": "+" added, "-" removed (no new number), " " unchanged.',
    '```',
    annotatedDiff,
    '```',
    '',
    '## Task',
    'Write review comments a careful senior reviewer would leave on the CHANGED lines of this file: bugs, edge cases, error handling, security, ' +
      'performance, unclear naming, missing tests. Skip praise and pure style nits. At most 8 comments; fewer is fine; none is fine. ' +
      'For each: the new-file line number it applies to (must be a numbered line from the diff), a severity, and a short comment written ' +
      'directly to the author in markdown. Suggest the fix when it is clear.',
    focusLine(focus),
    deep ? DEEP_NOTE : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export const SUGGEST_SCHEMA = {
  type: 'object',
  properties: {
    comments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['issue', 'suggestion', 'question', 'nit'] },
          body: { type: 'string' },
        },
        required: ['line', 'severity', 'body'],
      },
    },
  },
  required: ['comments'],
} as const;

/** Whole file with 1-based line numbers, truncated to `max` chars. */
export function numberedFile(lines: string[], max = Infinity): string {
  const out: string[] = [];
  let size = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = `${String(i + 1).padStart(5)}  ${lines[i]}`;
    if (size + l.length > max) {
      out.push('… (rest of file truncated)');
      break;
    }
    out.push(l);
    size += l.length + 1;
  }
  return out.join('\n');
}

/** `-U0` hunks as a compact unified diff, truncated to `max` chars. */
export function unifiedDiff(f: { hunks: Hunk[] }, max = Infinity): string {
  const parts: string[] = [];
  let size = 0;
  for (const h of f.hunks) {
    const block = [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines].join('\n');
    if (size + block.length > max) {
      parts.push('… (rest of diff truncated)');
      break;
    }
    parts.push(block);
    size += block.length;
  }
  return parts.join('\n');
}

/**
 * Hunks with `context` lines of surrounding new-file code, each line prefixed with its new line number.
 * `newLines` is the new file split into lines.
 */
export function annotatedDiff(hunks: Hunk[], newLines: string[], context = 4, max = 30_000): string {
  const out: string[] = [];
  let lastPrinted = 0;
  const num = (n: number) => String(n).padStart(5);
  for (const h of hunks) {
    const firstNew = h.newLines > 0 ? h.newStart : h.newStart + 1;
    const from = Math.max(lastPrinted + 1, firstNew - context);
    if (out.length && from > lastPrinted + 1) out.push('  ...');
    for (let l = from; l < firstNew; l++) out.push(`${num(l)}   ${newLines[l - 1] ?? ''}`);
    let n = h.newStart;
    for (const raw of h.lines) {
      if (raw[0] === '-') out.push(`${' '.repeat(5)} - ${raw.slice(1)}`);
      else if (raw[0] === '+') out.push(`${num(n++)} + ${raw.slice(1)}`);
    }
    const end = h.newLines > 0 ? h.newStart + h.newLines - 1 : h.newStart;
    const to = Math.min(newLines.length, end + context);
    for (let l = end + 1; l <= to; l++) out.push(`${num(l)}   ${newLines[l - 1] ?? ''}`);
    lastPrinted = to;
    if (out.join('\n').length > max) {
      out.push('… (truncated)');
      break;
    }
  }
  return out.join('\n');
}
