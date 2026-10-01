// Conventional Comments (https://conventionalcomments.org) shorthands: "nit: rename this" → "**nit:** rename this".

const LABELS: Record<string, string> = {
  n: 'nit',
  nit: 'nit',
  q: 'question',
  question: 'question',
  s: 'suggestion',
  suggestion: 'suggestion',
  i: 'issue',
  issue: 'issue',
  b: 'issue (blocking)',
  blocking: 'issue (blocking)',
  p: 'praise',
  praise: 'praise',
  t: 'thought',
  thought: 'thought',
  c: 'chore',
  chore: 'chore',
  todo: 'todo',
};

const PREFIX = /^\s*([a-z]+)(\s*\((?:non-)?blocking\))?\s*:\s+/i;

/** Expand a leading shorthand label; text without one (or already bold) is returned unchanged. */
export function applyCommentLabel(text: string): string {
  const m = PREFIX.exec(text);
  if (!m) return text;
  const label = LABELS[m[1].toLowerCase()];
  if (!label) return text;
  const decoration = m[2] ? m[2].trim().toLowerCase() : '';
  const full = decoration && !label.includes('(') ? `${label} ${decoration}` : label;
  return `**${full}:** ${text.slice(m[0].length)}`;
}

/** Label of a comment body written with Conventional Comments, e.g. "nit" or "issue (blocking)". */
export function commentLabel(body: string): string | undefined {
  return /^\s*\*\*([a-z]+(?: \((?:non-)?blocking\))?):\*\*/i.exec(body)?.[1].toLowerCase();
}
