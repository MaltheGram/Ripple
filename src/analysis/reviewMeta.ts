import * as vscode from 'vscode';
import { CODEOWNERS_PATHS, isOwner, type OwnerRule, ownersOf, parseCodeowners } from '../core/codeowners';
import { type ChangedCoverage, changedLineCoverage, type LineHits, parseLcov, resolveCoveragePaths } from '../core/coverage';
import type { GlApprovalRule, GlJob, GlPipeline } from '../gitlab/types';
import { log, timed } from '../log';
import type { ReviewSession } from '../ui/session';

/** Everything around the code of an MR: approvals, code owners, CI and coverage. Memory only; reloaded on refresh. */
export interface ReviewMeta {
  approvals?: GlApprovalRule[];
  /** path → owners (only when the repo has a CODEOWNERS file). */
  owners?: Map<string, string[]>;
  /** Paths the current user owns. */
  mine?: Set<string>;
  pipeline?: GlPipeline & { forCurrentVersion: boolean };
  failedJobs?: GlJob[];
  /** path → coverage of the MR's changed lines. */
  coverage?: Map<string, ChangedCoverage>;
  /** Where coverage came from, e.g. "test-affected #123". */
  coverageSource?: string;
}

/** Coverage report locations tried per app/lib folder, relative to the job's artifacts. `{dir}` = e.g. apps/web. */
function coveragePaths(): string[] {
  return vscode.workspace.getConfiguration('ripple.coverage').get<string[]>('paths', ['coverage/{dir}/lcov.info', 'coverage/lcov.info']);
}

export async function loadReviewMeta(s: ReviewSession): Promise<ReviewMeta> {
  const { projectId, iid } = s.entry;
  const [approvals, owners, ci] = await Promise.all([
    s.client.approvalState(projectId, iid).then((a) => a.rules).catch(soft('approvals')),
    loadOwners(s).catch(soft('CODEOWNERS')),
    loadCi(s).catch(soft('pipeline')),
  ]);
  return { approvals, ...owners, ...ci };
}

async function loadOwners(s: ReviewSession): Promise<Pick<ReviewMeta, 'owners' | 'mine'>> {
  let text: string | undefined;
  for (const p of CODEOWNERS_PATHS) {
    text = await s.client.fileRaw(s.entry.projectId, p, s.refs.head_sha);
    if (text) break;
  }
  if (!text) return {};
  const rules: OwnerRule[] = parseCodeowners(text);
  const [me, groups] = await Promise.all([s.me ?? s.client.currentUser(), s.client.myGroups().catch(() => [])]);
  const owners = new Map<string, string[]>();
  const mine = new Set<string>();
  for (const f of s.files) {
    const o = ownersOf(f.path, rules);
    if (!o.length) continue;
    owners.set(f.path, o);
    if (isOwner(o, me.username, groups.map((g) => g.full_path))) mine.add(f.path);
  }
  return { owners, mine };
}

async function loadCi(s: ReviewSession): Promise<Pick<ReviewMeta, 'pipeline' | 'failedJobs' | 'coverage' | 'coverageSource'>> {
  const { projectId } = s.entry;
  const [latest] = await s.client.mrPipelines(projectId, s.entry.iid);
  if (!latest) return {};
  const pipeline = { ...latest, forCurrentVersion: latest.sha === s.refs.head_sha };
  const jobs = await s.client.pipelineJobs(projectId, latest.id);
  const failedJobs = jobs.filter((j) => j.status === 'failed');

  // Coverage: lcov files in the artifacts of test jobs, one per app/lib the MR touches.
  const testJobs = jobs.filter((j) => /test|coverage|jest|vitest/i.test(j.name) && (j.artifacts ?? []).some((a) => a.file_type === 'archive'));
  if (!testJobs.length) return { pipeline, failedJobs };
  // Project folders the MR touches, plus the repo root for single-project repositories.
  const dirs = [...new Set(s.files.map((f) => projectDir(f.path)).filter((d): d is string => !!d)), ''];
  const repoPaths = s.files.map((f) => f.path);
  const hits = new Map<string, LineHits>();
  let source: string | undefined;
  await timed('coverage', async () => {
    for (const job of testJobs) {
      for (const dir of dirs) {
        for (const template of coveragePaths()) {
          if (!dir && template.includes('{dir}')) continue;
          const text = await s.client.artifactFile(projectId, job.id, template.replace('{dir}', dir));
          if (!text) continue;
          for (const [p, h] of resolveCoveragePaths(parseLcov(text), repoPaths, dir)) hits.set(p, h);
          source = `${job.name} #${job.id}`;
          break;
        }
      }
    }
  });
  if (!hits.size) return { pipeline, failedJobs };
  const coverage = new Map<string, ChangedCoverage>();
  for (const f of s.files) {
    const h = hits.get(f.path);
    if (h && f.change !== 'deleted') coverage.set(f.path, changedLineCoverage(f.hunks, h));
  }
  return { pipeline, failedJobs, coverage, coverageSource: source };
}

/** `apps/web/src/x.ts` → `apps/web` (Nx/monorepo project folder), else undefined. */
function projectDir(path: string): string | undefined {
  const parts = path.split('/');
  return ['apps', 'libs', 'packages', 'services'].includes(parts[0]) && parts.length > 2 ? `${parts[0]}/${parts[1]}` : undefined;
}

function soft(what: string) {
  return (e: unknown) => {
    log().warn(`${what}: ${e instanceof Error ? e.message : e}`);
    return undefined;
  };
}
