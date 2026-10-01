import * as vscode from 'vscode';
import { formatTokens } from './claude';

export type Depth = 'diff' | 'context' | 'full' | 'deep';
export type Focus = 'security' | 'performance' | 'correctness' | 'errors' | 'tests' | 'api' | 'data';
export type Scope = 'all' | 'visible';

/** Choices that shape AI answers. Part of every AI cache key, so a change allows a new run. */
export interface AiOptions {
  model: string;
  depth: Depth;
  /** Rough cap on tokens sent (diff budget; in deep mode also caps what Claude reads). */
  maxTokens: number;
  scope: Scope;
  includeTests: boolean;
  focus: Focus[];
}

export const DEPTHS: Record<Depth, { label: string; detail: string }> = {
  diff: { label: 'Changed lines only', detail: 'Cheapest. Claude sees only what changed.' },
  context: { label: 'Changed lines + context', detail: 'Adds ~6 surrounding lines per change. Good default.' },
  full: { label: 'Full changed files', detail: 'Whole new version of each changed file. More tokens, better understanding.' },
  deep: {
    label: 'Deep (read the repo)',
    detail: 'Claude may read other files in the MR checkout (read-only) to check callers, definitions and conventions. Slowest, most tokens; capped by max tokens.',
  },
};

export const FOCUS: Record<Focus, string> = {
  security: 'Security (auth, permissions, injection, secrets)',
  performance: 'Performance (N+1 queries, loops, memory)',
  correctness: 'Correctness and edge cases',
  errors: 'Error handling',
  tests: 'Missing or weak tests',
  api: 'API / contract compatibility',
  data: 'Data, migrations and transactions',
};

const STATE_KEY = 'ripple.aiOptions';
const MODELS = ['sonnet', 'haiku', 'opus'];
const TOKEN_STEPS = [10_000, 30_000, 60_000, 100_000];

export function defaultOptions(): AiOptions {
  const cfg = vscode.workspace.getConfiguration('ripple.ai');
  return {
    model: cfg.get('model', 'sonnet'),
    depth: 'context',
    maxTokens: cfg.get('maxInputTokens', 30_000),
    scope: 'all',
    includeTests: true,
    focus: [],
  };
}

/** The user's last chosen options (their defaults). Stored as a preference, not as cached results. */
export function loadOptions(context: vscode.ExtensionContext): AiOptions {
  return { ...defaultOptions(), ...context.globalState.get<Partial<AiOptions>>(STATE_KEY, {}) };
}

export function saveOptions(context: vscode.ExtensionContext, o: AiOptions) {
  return context.globalState.update(STATE_KEY, o);
}

/** Stable identity of the options for cache keys. */
export function optionsKey(o: AiOptions): string {
  return JSON.stringify([o.model, o.depth, o.maxTokens, o.scope, o.includeTests, [...o.focus].sort()]);
}

export function describeOptions(o: AiOptions): string {
  return [
    o.model,
    DEPTHS[o.depth].label.toLowerCase(),
    `≤${formatTokens(o.maxTokens)} tokens`,
    o.scope === 'visible' ? 'visible files' : 'all files',
    o.includeTests ? '' : 'no tests',
    o.focus.length ? `focus: ${o.focus.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export interface Estimate {
  tokens: number;
  files: number;
  omitted: number;
}

type Item = vscode.QuickPickItem & { action: 'run' | 'model' | 'depth' | 'tokens' | 'scope' | 'tests' | 'focus' };

/**
 * Options menu with a live token estimate. Returns the chosen options when the user picks the run item,
 * or undefined when dismissed. The choices are saved as the new defaults either way once changed.
 */
export async function pickOptions(
  context: vscode.ExtensionContext,
  runLabel: string,
  estimate: (o: AiOptions) => Estimate,
): Promise<AiOptions | undefined> {
  let o = loadOptions(context);
  for (;;) {
    const e = estimate(o);
    const cost =
      o.depth === 'deep'
        ? `~${formatTokens(e.tokens)} tokens + files Claude reads (capped at ≈${formatTokens(o.maxTokens)})`
        : `~${formatTokens(e.tokens)} tokens`;
    const items: Item[] = [
      {
        action: 'run',
        label: `$(sparkle) ${runLabel}`,
        description: `${cost} · ${e.files} files${e.omitted ? ` · ${e.omitted} diffs left out (budget)` : ''}`,
        alwaysShow: true,
      },
      { action: 'model', label: '', kind: vscode.QuickPickItemKind.Separator },
      { action: 'model', label: `$(hubot) Model: ${o.model}`, description: o.model === 'haiku' ? 'lightest on your usage' : o.model === 'opus' ? 'strongest, heaviest' : 'balanced' },
      { action: 'depth', label: `$(layers) File depth: ${DEPTHS[o.depth].label}`, detail: DEPTHS[o.depth].detail },
      { action: 'tokens', label: `$(dashboard) Max tokens: ${formatTokens(o.maxTokens)}`, description: 'largest diffs are left out first' },
      { action: 'scope', label: `$(filter) Scope: ${o.scope === 'visible' ? 'Files shown in the Review list' : 'All substantive files'}` },
      { action: 'tests', label: `$(beaker) Test files: ${o.includeTests ? 'included' : 'left out'}` },
      { action: 'focus', label: `$(target) Focus: ${o.focus.length ? o.focus.map((f) => FOCUS[f].split(' (')[0]).join(', ') : 'general review'}` },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: 'AI options', placeHolder: 'Pick an option to change it, or run', ignoreFocusOut: true });
    if (!pick) return undefined;
    if (pick.action === 'run') {
      await saveOptions(context, o);
      return o;
    }
    const next = await changeOption(o, pick.action);
    if (next) {
      o = next;
      await saveOptions(context, o);
    }
  }
}

async function changeOption(o: AiOptions, action: Item['action']): Promise<AiOptions | undefined> {
  switch (action) {
    case 'model': {
      const p = await vscode.window.showQuickPick(
        MODELS.map((m) => ({ label: m, picked: m === o.model })),
        { title: 'Model (claude --model alias)' },
      );
      return p && { ...o, model: p.label };
    }
    case 'depth': {
      const p = await vscode.window.showQuickPick(
        (Object.keys(DEPTHS) as Depth[]).map((d) => ({ label: DEPTHS[d].label, detail: DEPTHS[d].detail, d, description: d === o.depth ? 'current' : '' })),
        { title: 'How much code Claude sees' },
      );
      return p && { ...o, depth: p.d };
    }
    case 'tokens': {
      const p = await vscode.window.showQuickPick(
        [...TOKEN_STEPS.map((t) => ({ label: formatTokens(t), t })), { label: 'Custom…', t: -1 }],
        { title: 'Max tokens to send' },
      );
      if (!p) return undefined;
      if (p.t > 0) return { ...o, maxTokens: p.t };
      const v = await vscode.window.showInputBox({
        title: 'Max tokens',
        value: String(o.maxTokens),
        validateInput: (x) => (/^\d+$/.test(x) && Number(x) >= 2000 ? undefined : 'A number ≥ 2000'),
      });
      return v ? { ...o, maxTokens: Number(v) } : undefined;
    }
    case 'scope': {
      const p = await vscode.window.showQuickPick(
        [
          { label: 'All substantive files', s: 'all' as const },
          { label: 'Files shown in the Review list', description: 'respects current filters and focus', s: 'visible' as const },
        ],
        { title: 'Which files' },
      );
      return p && { ...o, scope: p.s };
    }
    case 'tests':
      return { ...o, includeTests: !o.includeTests };
    case 'focus': {
      const p = await vscode.window.showQuickPick(
        (Object.keys(FOCUS) as Focus[]).map((f) => ({ label: FOCUS[f], f, picked: o.focus.includes(f) })),
        { title: 'Focus areas (none = general review)', canPickMany: true },
      );
      return p && { ...o, focus: p.map((x) => x.f) };
    }
    default:
      return undefined;
  }
}
