import type * as vscode from 'vscode';
import type { ChangedFile } from '../core/types';
import { readWorktreeFileSync } from '../repo/safeRead';
import type { ReviewSession } from '../ui/session';
import { requireClaude, runClaude } from './claude';
import { FOCUS, optionsKey, type AiOptions } from './options';
import { ANALYSIS_SCHEMA, analysisPrompt, annotatedDiff, estimateTokens, numberedFile, REVIEWER_SYSTEM, tokensToChars, unifiedDiff } from './prompts';

export type RiskSeverity = 'high' | 'medium' | 'low';

export interface AiRisk {
  file: string;
  line?: number;
  severity: RiskSeverity;
  category: string;
  note: string;
}

export interface AiGroup {
  key: string;
  title: string;
  why: string;
  files: string[];
}

/** Held in memory on the session only; recomputed for a new MR version. */
export interface AiAnalysis {
  headSha: string;
  options: AiOptions;
  /** `optionsKey(options)`: a result is reused only for the same MR version and options. */
  optionsKey: string;
  summary: string;
  /** In suggested review order. */
  groups: AiGroup[];
  risks: AiRisk[];
  omitted: string[];
}

interface Raw {
  summary: string;
  groups: { title: string; why: string; files: string[] }[];
  risks: { file: string; line: number | null; severity: RiskSeverity; category: string; note: string }[];
}

export interface PreparedAnalysis {
  prompt: string;
  omitted: string[];
  tokens: number;
  /** Files in scope (all, or the ones shown in the Review list). */
  files: ChangedFile[];
}

/** Per-file caps by depth: deeper modes may use more of the budget per file. */
const PER_FILE_CAP = { diff: 6_000, context: 9_000, full: 24_000, deep: 9_000 } as const;

/** Build the prompt for these options without calling Claude (also used for the live estimate). */
export function prepareAnalysis(s: ReviewSession, o: AiOptions): PreparedAnalysis {
  const files = o.scope === 'visible' ? s.visibleFiles() : s.files;
  const { prompt, omitted } = analysisPrompt(s.mr, files, {
    maxChars: tokensToChars(o.maxTokens),
    perFileCap: PER_FILE_CAP[o.depth],
    render: fileRenderer(s, o),
    includeTests: o.includeTests,
    focus: o.focus.map((f) => FOCUS[f]),
    deep: o.depth === 'deep',
  });
  return { prompt, omitted, tokens: estimateTokens(prompt), files };
}

/** How one file is shown to Claude at a given depth. */
export function fileRenderer(s: ReviewSession, o: AiOptions): (f: ChangedFile, cap: number) => string {
  const newLines = (f: ChangedFile): string[] | undefined => {
    if (f.change === 'deleted') return undefined;
    return readWorktreeFileSync(s.entry.worktree, f.path)?.split('\n');
  };
  return (f, cap) => {
    if (o.depth === 'diff') return unifiedDiff(f, cap);
    const lines = newLines(f);
    if (!lines) return unifiedDiff(f, cap);
    if (o.depth === 'full') {
      const diff = unifiedDiff(f, Math.floor(cap / 3));
      return `${numberedFile(lines, cap - diff.length)}\n\n--- changes in this MR ---\n${diff}`;
    }
    return annotatedDiff(f.hunks, lines, 6, cap);
  };
}

export async function analyzeMr(s: ReviewSession, prepared: PreparedAnalysis, o: AiOptions, cancel?: vscode.CancellationToken): Promise<AiAnalysis> {
  await requireClaude();
  const { prompt, omitted } = prepared;
  const raw = await runClaude<Raw>({
    prompt,
    system: REVIEWER_SYSTEM,
    schema: ANALYSIS_SCHEMA,
    model: o.model,
    label: 'AI review',
    cancel,
    deep: o.depth === 'deep' ? { cwd: s.entry.worktree, maxTokens: o.maxTokens } : undefined,
  });

  // Keep only real paths; every substantive file ends up in exactly one group.
  const known = new Set(s.files.map((f) => f.path));
  const seen = new Set<string>();
  const groups: AiGroup[] = [];
  for (const g of raw.groups) {
    const files = g.files.map(normalize).filter((p) => known.has(p) && !seen.has(p));
    files.forEach((p) => seen.add(p));
    if (files.length) groups.push({ key: `ai:${groups.length}`, title: g.title, why: g.why, files });
  }
  const rest = prepared.files.filter((f) => !f.trivial && !seen.has(f.path)).map((f) => f.path);
  if (rest.length) groups.push({ key: `ai:${groups.length}`, title: 'Other changes', why: 'Files the AI did not place in a group.', files: rest });

  const risks = raw.risks
    .map((r) => ({ ...r, file: normalize(r.file), line: r.line ?? undefined }))
    .filter((r) => known.has(r.file));

  return { headSha: s.refs.head_sha, options: o, optionsKey: optionsKey(o), summary: raw.summary.trim(), groups, risks, omitted };
}

function normalize(p: string): string {
  return p.trim().replace(/^[ab]\//, '').replace(/^\.\//, '');
}

export const SEVERITY_ICON: Record<RiskSeverity, string> = { high: '🔴', medium: '🟠', low: '🟡' };

/** Markdown for the MR Overview and for posting to GitLab. */
export function analysisMarkdown(a: AiAnalysis, forGitLab = false): string {
  const lines = [
    forGitLab ? '### 🤖 AI review summary' : '## AI summary',
    '',
    a.summary,
    '',
    forGitLab ? '#### Suggested review order' : '## Suggested review order',
    ...a.groups.map((g, i) => `${i + 1}. **${g.title}** (${g.files.length} files): ${g.why}`),
  ];
  if (a.risks.length) {
    lines.push('', forGitLab ? '#### Risk hotspots' : '## Risk hotspots');
    for (const r of a.risks) lines.push(`- ${SEVERITY_ICON[r.severity]} \`${r.file}${r.line ? `:${r.line}` : ''}\` **${r.category}**: ${r.note}`);
  }
  if (forGitLab) lines.push('', '_Generated with Ripple (Claude). Double-check before relying on it._');
  return lines.join('\n');
}
