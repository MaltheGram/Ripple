import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { sanitizeAiOutput } from '../core/sanitize';
import { log } from '../log';

/**
 * Runs Claude through the developer's own `claude` CLI login (headless Claude Code).
 * The extension never sees or stores Claude credentials.
 *
 * Every call is sandboxed: no tools (`--tools ""`), no MCP servers, no user/project settings, hooks or
 * plugins (`--restricted`), no saved session. Claude only sees the text we send on stdin.
 */
export interface ClaudeRequest {
  prompt: string;
  system: string;
  schema: object;
  /** 'default' → ripple.ai.model, 'fast' → ripple.ai.fastModel, or an explicit alias. */
  model?: 'default' | 'fast' | (string & {});
  /** Shown in the usage log, e.g. "AI review". */
  label: string;
  cancel?: vscode.CancellationToken;
  /**
   * Deep mode: Claude may use read-only Read/Grep/Glob inside `cwd` (the MR checkout; `--restricted` keeps
   * file tools inside it). Spending is capped via --max-budget-usd derived from `maxTokens`.
   */
  deep?: { cwd: string; maxTokens: number };
}

/** Approximate $/M input tokens per alias, only used to turn a token cap into --max-budget-usd. */
const INPUT_PRICE: Record<string, number> = { haiku: 1, sonnet: 3, opus: 5 };

function budgetUsd(model: string, maxTokens: number): string {
  const price = INPUT_PRICE[model] ?? 5;
  // Input budget plus headroom for output and tool-result round trips.
  return Math.max(0.05, (maxTokens / 1_000_000) * price * 2).toFixed(2);
}

export interface ClaudeUsage {
  label: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

/** Usage in this VS Code window (memory only). */
export const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
const usageEvents = new vscode.EventEmitter<ClaudeUsage>();
export const onDidUseClaude = usageEvents.event;

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

export function modelFor(choice: ClaudeRequest['model']): string {
  const cfg = vscode.workspace.getConfiguration('ripple.ai');
  if (!choice || choice === 'default') return cfg.get('model', 'sonnet');
  if (choice === 'fast') return cfg.get('fastModel', 'haiku');
  return choice;
}

const TIMEOUT_MS = 5 * 60_000;

export class ClaudeError extends Error {}

export async function runClaude<T>(req: ClaudeRequest): Promise<T> {
  const bin = await claudeBinary();
  const model = modelFor(req.model);
  const args = [
    '-p',
    '--restricted',
    '--output-format', 'json',
    '--model', model,
    ...(req.deep
      ? ['--tools', 'Read,Grep,Glob', '--allowedTools', 'Read', 'Grep', 'Glob', '--max-budget-usd', budgetUsd(model, req.deep.maxTokens)]
      : ['--tools', '']),
    '--strict-mcp-config',
    '--no-session-persistence',
    '--system-prompt', req.system,
    '--json-schema', JSON.stringify(req.schema),
  ];

  const started = Date.now();
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env, cwd: req.deep?.cwd });
    // Collect raw buffers: decoding per chunk would break multi-byte characters split across chunks.
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TIMEOUT_MS);
    const sub = req.cancel?.onCancellationRequested(() => child.kill());
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => reject(new ClaudeError(`Could not start claude: ${e.message}`)));
    // If claude exits before reading its input, writing stdin fails with EPIPE; the exit code tells the story.
    child.stdin.on('error', () => undefined);
    child.on('close', (code) => {
      clearTimeout(timer);
      sub?.dispose();
      const stdout = Buffer.concat(out).toString('utf8');
      if (req.cancel?.isCancellationRequested) reject(new vscode.CancellationError());
      else if (timedOut) reject(new ClaudeError(`Claude did not answer within ${TIMEOUT_MS / 60_000} minutes. Try a smaller scope.`));
      else if (code !== 0 && !stdout) reject(new ClaudeError(`claude exited with ${code}: ${Buffer.concat(err).toString('utf8').trim().slice(0, 500)}`));
      else resolve(stdout);
    });
    child.stdin.end(req.prompt);
  });

  let res: {
    is_error?: boolean;
    subtype?: string;
    result?: string;
    structured_output?: T;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  };
  try {
    res = JSON.parse(stdout);
  } catch {
    throw new ClaudeError(`Unexpected output from claude: ${stdout.slice(0, 300)}`);
  }
  const u = res.usage ?? {};
  const used: ClaudeUsage = {
    label: req.label,
    model,
    inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    ms: Date.now() - started,
  };
  usage.calls++;
  usage.inputTokens += used.inputTokens;
  usage.outputTokens += used.outputTokens;
  usageEvents.fire(used);
  log().info(
    `claude ${req.label} (${model}): ${used.ms} ms, ${formatTokens(used.inputTokens)} in / ${formatTokens(used.outputTokens)} out · ` +
      `window total ${formatTokens(usage.inputTokens + usage.outputTokens)} tokens in ${usage.calls} calls`,
  );
  if (res.is_error || res.subtype !== 'success' || res.structured_output === undefined) {
    throw new ClaudeError(`Claude returned an error: ${res.result ?? res.subtype ?? 'unknown'}`);
  }
  return sanitizeAiOutput(res.structured_output);
}

export type ClaudeStatus = { ok: true } | { ok: false; reason: 'missing' | 'signed-out'; detail: string };

let statusCache: Promise<ClaudeStatus> | undefined;

/** Is the `claude` CLI installed and signed in? Cached until `resetClaudeStatus`. */
export function claudeStatus(): Promise<ClaudeStatus> {
  statusCache ??= (async (): Promise<ClaudeStatus> => {
    let bin: string;
    try {
      bin = await claudeBinary();
    } catch (e) {
      return { ok: false, reason: 'missing', detail: e instanceof Error ? e.message : String(e) };
    }
    const out = await new Promise<string>((resolve) =>
      execFile(bin, ['auth', 'status', '--json'], { timeout: 15_000 }, (_e, stdout) => resolve(stdout)),
    );
    try {
      if (JSON.parse(out).loggedIn) return { ok: true };
    } catch {
      // fall through
    }
    return { ok: false, reason: 'signed-out', detail: 'Run "claude" in a terminal and sign in with /login.' };
  })();
  return statusCache;
}

export function resetClaudeStatus() {
  statusCache = undefined;
}

/** Throw a friendly error (with a setup hint) unless Claude is ready. */
export async function requireClaude(): Promise<void> {
  const st = await claudeStatus();
  if (st.ok) return;
  resetClaudeStatus();
  const msg =
    st.reason === 'missing'
      ? 'AI features need the Claude Code CLI ("claude"). Install it, sign in with your own subscription, then try again.'
      : 'The Claude Code CLI is not signed in. Run "claude" in a terminal and use /login with your own subscription.';
  throw new ClaudeError(msg);
}

/** The configured path, else `claude` on PATH, else common install locations (GUI apps may lack the shell PATH). */
async function claudeBinary(): Promise<string> {
  const configured = vscode.workspace.getConfiguration('ripple.ai').get<string>('claudePath', '').trim();
  if (configured) {
    if (!existsSync(configured)) throw new ClaudeError(`ripple.ai.claudePath not found: ${configured}`);
    return configured;
  }
  const onPath = await new Promise<string | undefined>((resolve) =>
    execFile('which', ['claude'], (e, out) => resolve(e ? undefined : out.trim() || undefined)),
  );
  if (onPath) return onPath;
  for (const p of [path.join(homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', path.join(homedir(), '.claude/local/claude')]) {
    if (existsSync(p)) return p;
  }
  throw new ClaudeError('Claude Code CLI ("claude") not found. Install it or set ripple.ai.claudePath.');
}
