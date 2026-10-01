import * as path from 'node:path';
import type { ExplainResult } from '../ai/explain';

// Pure markdown for an explanation document (no vscode import), so it's easy to test.

export const VERDICT_LABEL: Record<ExplainResult['answer']['verdict'], string> = {
  changed: '🟡 Changed in this MR',
  affected: '🟠 Affected by changes elsewhere in this MR',
  unaffected: '🟢 Not affected by this MR',
  unclear: '⚪ Unclear',
};

/**
 * Full explanation as markdown. `worktree` turns `file:line` causes into links that open the file at that line
 * (markdown preview understands `file:///…#L12`).
 */
export function explainMarkdown(r: ExplainResult, worktree: string): string {
  const t = r.target;
  const a = r.answer;
  const link = (file: string, line: number | null | undefined) => {
    const label = `${file}${line ? `:${line}` : ''}`;
    const uri = `file://${encodeURI(path.join(worktree, file))}${line ? `#L${line}` : ''}`;
    return `[\`${label}\`](${uri})`;
  };

  const lines = [
    `# ${t.label}`,
    '',
    `${link(t.rel, t.first + 1)}–${t.last + 1}${t.side === 'old' ? ' · _old version (before the MR)_' : ''}${t.file ? '' : ' · _file not changed by the MR_'}`,
    '',
    `## ${VERDICT_LABEL[a.verdict]}`,
    '',
    a.summary,
  ];
  if (a.effects.length) {
    lines.push('', '## Effects', '');
    a.effects.forEach((e, i) => {
      lines.push(`${i + 1}. **${e.kind}**: ${e.description}`, `   Caused by ${link(e.cause.file, e.cause.line)}${e.cause.symbol ? ` (\`${e.cause.symbol}\`)` : ''}`);
    });
  }
  if (a.checks.length) lines.push('', '## Check', '', ...a.checks.map((c) => `- [ ] ${c}`));
  if (r.followUps.length) {
    lines.push('', '## Follow-up questions');
    for (const f of r.followUps) lines.push('', `### ${f.question}`, '', f.answer);
  }
  lines.push('', '## Context used', '', `- ${r.ownChanges} change(s) inside the selection`, `- ${r.callers} caller(s)`);
  for (const d of r.dependencies) lines.push(`- \`${d.name}\` ${link(d.path, d.line)}${d.how !== 'definition' ? ` _(${d.how})_` : ''}`);
  lines.push(
    '',
    '---',
    '',
    `_Claude (${r.model})${r.reused ? ', already generated for this MR version' : ''}. Ask follow-ups or add this as a review comment from the Explain list in the sidebar. Double-check against the code._`,
  );
  return lines.join('\n');
}
