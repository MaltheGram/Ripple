import type {
  GlApprovals,
  GlApprovalState,
  GlBlameRange,
  GlGroupRef,
  GlJob,
  GlMrVersion,
  GlPipeline,
  GlBlob,
  GlDiscussion,
  GlDraftNote,
  GlGroup,
  GlMergeRequest,
  GlNote,
  GlPosition,
  GlProject,
  GlUser,
} from './types';

export class GitLabError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Seconds, from the Retry-After header (rate limits). */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined>;

/** Thin typed client over the GitLab REST API v4. `getToken` is called per request so refreshed tokens are picked up. */
export class GitLabClient {
  constructor(
    readonly baseUrl: string,
    private readonly getToken: () => Promise<string>,
  ) {}

  currentUser() {
    return this.get<GlUser>('/user');
  }

  project(idOrPath: number | string) {
    return this.get<GlProject>(`/projects/${enc(idOrPath)}`);
  }

  mergeRequest(projectId: number, iid: number) {
    return this.get<GlMergeRequest>(`/projects/${projectId}/merge_requests/${iid}`);
  }

  reviewRequests(username: string) {
    return this.get<GlMergeRequest[]>('/merge_requests', {
      scope: 'all',
      state: 'opened',
      reviewer_username: username,
      per_page: 50,
    });
  }

  assignedToMe() {
    return this.get<GlMergeRequest[]>('/merge_requests', { scope: 'assigned_to_me', state: 'opened', per_page: 50 });
  }

  createdByMe() {
    return this.get<GlMergeRequest[]>('/merge_requests', { scope: 'created_by_me', state: 'opened', per_page: 50 });
  }

  /** Top-level groups the user is a member of. */
  myTopGroups() {
    return this.get<GlGroup[]>('/groups', { top_level_only: true, min_access_level: 10, per_page: 50 });
  }

  /** Open MRs in a group and its subgroups, most recently updated first. */
  groupMergeRequests(group: number | string, limit = 100) {
    return this.get<GlMergeRequest[]>(`/groups/${enc(group)}/merge_requests`, {
      state: 'opened',
      order_by: 'updated_at',
      per_page: limit,
    });
  }

  discussions(projectId: number, iid: number) {
    return this.all<GlDiscussion>(`/projects/${projectId}/merge_requests/${iid}/discussions`);
  }

  createDiscussion(projectId: number, iid: number, body: string, position?: GlPosition) {
    return this.post<GlDiscussion>(`/projects/${projectId}/merge_requests/${iid}/discussions`, { body, position });
  }

  reply(projectId: number, iid: number, discussionId: string, body: string) {
    return this.post<GlNote>(`/projects/${projectId}/merge_requests/${iid}/discussions/${discussionId}/notes`, { body });
  }

  setResolved(projectId: number, iid: number, discussionId: string, resolved: boolean) {
    return this.request<GlDiscussion>('PUT', `/projects/${projectId}/merge_requests/${iid}/discussions/${discussionId}`, {
      resolved,
    });
  }

  drafts(projectId: number, iid: number) {
    return this.all<GlDraftNote>(`/projects/${projectId}/merge_requests/${iid}/draft_notes`);
  }

  createDraft(
    projectId: number,
    iid: number,
    draft: { note: string; position?: GlPosition; in_reply_to_discussion_id?: string },
  ) {
    return this.post<GlDraftNote>(`/projects/${projectId}/merge_requests/${iid}/draft_notes`, draft);
  }

  deleteDraft(projectId: number, iid: number, draftId: number) {
    return this.request<void>('DELETE', `/projects/${projectId}/merge_requests/${iid}/draft_notes/${draftId}`);
  }

  publishDrafts(projectId: number, iid: number) {
    return this.post<void>(`/projects/${projectId}/merge_requests/${iid}/draft_notes/bulk_publish`, {});
  }

  approvals(projectId: number, iid: number) {
    return this.get<GlApprovals>(`/projects/${projectId}/merge_requests/${iid}/approvals`);
  }

  /** `sha` guards against approving a version you haven't seen. */
  approve(projectId: number, iid: number, sha: string) {
    return this.post<GlApprovals>(`/projects/${projectId}/merge_requests/${iid}/approve`, { sha });
  }

  unapprove(projectId: number, iid: number) {
    return this.post<void>(`/projects/${projectId}/merge_requests/${iid}/unapprove`, {});
  }

  /** Approval rules and who has approved (Premium). */
  approvalState(projectId: number, iid: number) {
    return this.get<GlApprovalState>(`/projects/${projectId}/merge_requests/${iid}/approval_state`);
  }

  /** Pipelines of an MR, newest first. */
  mrPipelines(projectId: number, iid: number) {
    return this.get<GlPipeline[]>(`/projects/${projectId}/merge_requests/${iid}/pipelines`, { per_page: 5 });
  }

  pipelineJobs(projectId: number, pipelineId: number) {
    return this.all<GlJob>(`/projects/${projectId}/pipelines/${pipelineId}/jobs`);
  }

  /** One file from a job's artifacts archive (without downloading the archive). Undefined when missing. */
  async artifactFile(projectId: number, jobId: number, artifactPath: string): Promise<string | undefined> {
    try {
      return await this.getText(`/projects/${projectId}/jobs/${jobId}/artifacts/${artifactPath.split('/').map(encodeURIComponent).join('/')}`);
    } catch (e) {
      if (e instanceof GitLabError && e.status === 404) return undefined;
      throw e;
    }
  }

  /** Raw file content at a ref (e.g. CODEOWNERS). Undefined when missing. */
  async fileRaw(projectId: number, filePath: string, ref: string): Promise<string | undefined> {
    try {
      return await this.getText(`/projects/${projectId}/repository/files/${encodeURIComponent(filePath)}/raw`, { ref });
    } catch (e) {
      if (e instanceof GitLabError && e.status === 404) return undefined;
      throw e;
    }
  }

  /** MR versions (one per push), newest first. */
  mrVersions(projectId: number, iid: number) {
    return this.get<GlMrVersion[]>(`/projects/${projectId}/merge_requests/${iid}/versions`);
  }

  /** Blame for a line range of a file at a ref. */
  blame(projectId: number, filePath: string, ref: string, start: number, end: number) {
    return this.get<GlBlameRange[]>(`/projects/${projectId}/repository/files/${encodeURIComponent(filePath)}/blame`, {
      ref,
      'range[start]': start,
      'range[end]': end,
    });
  }

  /** MRs that contain a commit. */
  commitMergeRequests(projectId: number, sha: string) {
    return this.get<GlMergeRequest[]>(`/projects/${projectId}/repository/commits/${sha}/merge_requests`);
  }

  /** Groups the user belongs to (for CODEOWNERS group ownership). */
  myGroups() {
    return this.all<GlGroupRef>('/groups', { min_access_level: 10 });
  }

  /** Code search across a group and its subgroups (Advanced Search on Premium). */
  searchGroupBlobs(group: number | string, search: string) {
    return this.get<GlBlob[]>(`/groups/${enc(group)}/search`, { scope: 'blobs', search, per_page: 30 });
  }

  private async getText(path: string, query?: Query): Promise<string> {
    return (await this.raw<string>('GET', path, undefined, query, true)).data;
  }

  private get<T>(path: string, query?: Query) {
    return this.request<T>('GET', path, undefined, query);
  }

  private post<T>(path: string, body: unknown) {
    return this.request<T>('POST', path, body);
  }

  private async all<T>(path: string, query: Query = {}): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const { data, nextPage } = await this.raw<T[]>('GET', path, undefined, { ...query, per_page: 100, page });
      out.push(...data);
      if (!nextPage) return out;
    }
  }

  private async request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
    return (await this.raw<T>(method, path, body, query)).data;
  }

  /**
   * Reads (GET) are retried on rate limits (respecting Retry-After up to 10 s), 502/503/504 and network errors.
   * Writes are never retried, so a comment can't be posted twice.
   */
  private async raw<T>(method: string, path: string, body?: unknown, query?: Query, text = false) {
    const attempts = method === 'GET' ? 3 : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once<T>(method, path, body, query, text);
      } catch (e) {
        const retryable =
          e instanceof GitLabError ? e.status === 429 || e.status === 502 || e.status === 503 || e.status === 504 : e instanceof TypeError;
        if (!retryable || attempt >= attempts) throw e;
        const wait = e instanceof GitLabError && e.retryAfter ? e.retryAfter * 1000 : 500 * 2 ** attempt;
        if (wait > 10_000) throw e;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  private async once<T>(method: string, path: string, body?: unknown, query?: Query, asText = false) {
    const url = new URL(`${this.baseUrl}/api/v4${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await this.getToken()}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const retry = Number(res.headers.get('retry-after'));
      throw new GitLabError(res.status, `GitLab ${method} ${path} → ${res.status}: ${extractMessage(text)}`, Number.isFinite(retry) && retry > 0 ? retry : undefined);
    }
    const text = asText ? await readCapped(res, MAX_TEXT_BYTES, path) : await res.text();
    const data = asText ? text : text ? JSON.parse(text) : undefined;
    return { data: data as T, nextPage: res.headers.get('x-next-page') || undefined };
  }
}

/** Raw files (CI artifacts, repository files) are MR-controlled: cap their size. */
const MAX_TEXT_BYTES = 20 * 1024 * 1024;

async function readCapped(res: Response, max: number, what: string): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (declared > max) throw new GitLabError(413, `GitLab GET ${what}: file is too large (${Math.round(declared / 1e6)} MB, limit ${max / 1e6} MB)`);
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new GitLabError(413, `GitLab GET ${what}: file is larger than ${max / 1e6} MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function enc(idOrPath: number | string): string {
  return typeof idOrPath === 'number' ? String(idOrPath) : encodeURIComponent(idOrPath);
}

function extractMessage(text: string): string {
  try {
    const j = JSON.parse(text);
    return typeof j.message === 'string' ? j.message : JSON.stringify(j.message ?? j.error ?? j);
  } catch {
    return text.slice(0, 200);
  }
}
