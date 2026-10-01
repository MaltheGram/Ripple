import * as vscode from 'vscode';
import { type Contract, detectContracts } from '../core/contracts';
import { GitLabError } from '../gitlab/client';
import type { GlBlob, GlProject } from '../gitlab/types';
import { log, timed } from '../log';
import { readWorktreeFileSync } from '../repo/safeRead';
import type { ReviewSession } from '../ui/session';

/** GitLab search is rate limited; keep a scan well under the per-minute budget. */
const MAX_QUERIES = 15;
const QUERY_GAP_MS = 400;

export interface Usage {
  projectId: number;
  projectPath: string;
  /** Hit in the MR's own project (default branch), e.g. another app in a monorepo. */
  sameProject: boolean;
  path: string;
  line: number;
  snippet: string;
  url: string;
}

export interface ContractImpact {
  contract: Contract;
  usages: Usage[];
  /** Not searched (query budget or rate limit). */
  skipped?: boolean;
  error?: string;
}

/** Memory only; recomputed for a new MR version. */
export interface CrossServiceResult {
  headSha: string;
  group: string;
  items: ContractImpact[];
  /** Stopped early (rate limit). */
  partial: boolean;
}

export async function scanCrossService(
  s: ReviewSession,
  opts: { cancel?: vscode.CancellationToken; progress?: (msg: string) => void } = {},
): Promise<CrossServiceResult> {
  const contracts = detectContracts(s.files, (p) => readWorktreeFileSync(s.entry.worktree, p)?.split('\n'));
  const group = searchGroup(s);
  const changedPaths = new Set(s.files.map((f) => f.path));
  const projects = new Map<number, Promise<GlProject | undefined>>();
  const project = (id: number) => {
    if (!projects.has(id)) projects.set(id, s.client.project(id).catch(() => undefined));
    return projects.get(id)!;
  };

  const items: ContractImpact[] = contracts.map((contract) => ({ contract, usages: [] }));
  let partial = false;
  let queries = 0;
  for (const item of items) {
    if (opts.cancel?.isCancellationRequested) break;
    if (queries >= MAX_QUERIES || partial) {
      item.skipped = true;
      continue;
    }
    const c = item.contract;
    opts.progress?.(`${c.name} (${queries + 1}/${Math.min(items.length, MAX_QUERIES)})`);
    if (queries) await sleep(QUERY_GAP_MS);
    queries++;
    let blobs: GlBlob[];
    try {
      blobs = await timed(`search "${c.query}"`, () => searchWithRetry(s, group, c.query));
    } catch (e) {
      if (e instanceof GitLabError && e.status === 429) {
        partial = true;
        item.skipped = true;
        continue;
      }
      item.error = e instanceof GitLabError && (e.status === 403 || e.status === 404) ? `search not available for group "${group}" (${e.status})` : String(e instanceof Error ? e.message : e);
      log().warn(`cross-service search for ${c.name}: ${item.error}`);
      if (e instanceof GitLabError && (e.status === 403 || e.status === 404)) break;
      continue;
    }
    const seen = new Set<string>();
    for (const b of blobs) {
      const sameProject = b.project_id === s.entry.projectId;
      // Files the MR itself changes are under review already.
      if (sameProject && changedPaths.has(b.path)) continue;
      const hit = matchLine(b.data, c);
      if (hit === undefined) continue;
      const key = `${b.project_id}:${b.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const p = await project(b.project_id);
      const line = b.startline + hit;
      item.usages.push({
        projectId: b.project_id,
        projectPath: p?.path_with_namespace ?? `project ${b.project_id}`,
        sameProject,
        path: b.path,
        line,
        snippet: b.data.trim(),
        url: p ? `${p.web_url}/-/blob/${encodeURIComponent(b.ref)}/${b.path.split('/').map(encodeURIComponent).join('/')}#L${line}` : '',
      });
    }
  }
  return { headSha: s.refs.head_sha, group, items, partial };
}

/** The group to search: configured groups first, else the MR project's top-level group. */
function searchGroup(s: ReviewSession): string {
  const configured = vscode.workspace.getConfiguration('ripple.gitlab').get<string[]>('groups', []);
  const root = s.entry.projectPath.split('/')[0];
  return configured.find((g) => s.entry.projectPath.startsWith(`${g}/`)) ?? configured[0] ?? root;
}

async function searchWithRetry(s: ReviewSession, group: string, query: string): Promise<GlBlob[]> {
  try {
    return await s.client.searchGroupBlobs(group, query);
  } catch (e) {
    // One polite retry when GitLab says how long to wait.
    if (e instanceof GitLabError && e.status === 429 && e.retryAfter && e.retryAfter <= 30) {
      await sleep(e.retryAfter * 1000);
      return s.client.searchGroupBlobs(group, query);
    }
    throw e;
  }
}

/** Index of the line in a search snippet that really uses the contract (whole word / full route), else undefined. */
export function matchLine(data: string, c: Contract): number | undefined {
  const re = c.matcher ?? new RegExp(`(^|[^\\w$.-])${c.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w$-])`);
  const lines = data.split('\n');
  const i = lines.findIndex((l) => re.test(l));
  return i === -1 ? undefined : i;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export const IMPACT_LABEL: Record<Contract['impact'], string> = {
  breaking: 'possibly breaking',
  removed: 'removed',
  modified: 'modified',
  additive: 'additive',
  added: 'new',
};

/** Draft comment text for a contract and its usages. */
export function impactComment(item: ContractImpact): string {
  const c = item.contract;
  const byProject = new Map<string, Usage[]>();
  for (const u of item.usages) {
    if (!byProject.has(u.projectPath)) byProject.set(u.projectPath, []);
    byProject.get(u.projectPath)!.push(u);
  }
  const lines = [
    `**Cross-service impact**: \`${c.name}\` (${IMPACT_LABEL[c.impact]}${c.detail ? `: ${c.detail}` : ''}) is used outside this MR:`,
    '',
    ...[...byProject].flatMap(([project, us]) => [
      `- **${project}**${us[0].sameProject ? ' (this repo, default branch)' : ''}`,
      ...us.slice(0, 8).map((u) => `  - [\`${u.path}:${u.line}\`](${u.url})`),
      ...(us.length > 8 ? [`  - … and ${us.length - 8} more`] : []),
    ]),
    '',
    c.impact === 'breaking' || c.impact === 'removed'
      ? 'Could you confirm these consumers are updated or still compatible?'
      : 'Worth a quick check that these consumers still work as expected.',
  ];
  return lines.join('\n');
}
