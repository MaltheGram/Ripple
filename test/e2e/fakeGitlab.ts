import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Just enough of the GitLab v4 API for one project / one MR. Records every write for assertions. */
export interface FakeGitLab {
  url: string;
  /** Simulate a new push: the MR head moves (versions grow). */
  setHead(sha: string): void;
  /** lcov served as the test job's artifact `coverage/lcov.info`. */
  lcov: string;
  codeowners?: string;
  drafts: any[];
  discussions: any[];
  approvals: string[];
  close(): Promise<void>;
}

export async function startFakeGitLab(opts: {
  repoUrl: string;
  baseSha: string;
  headSha: string;
}): Promise<FakeGitLab> {
  const user = { id: 1, username: 'tester', name: 'Test User' };
  const project = { id: 7, path_with_namespace: 'acme/demo', http_url_to_repo: opts.repoUrl, web_url: '' };
  const state: Omit<FakeGitLab, 'url' | 'close' | 'setHead'> = { drafts: [], discussions: [], approvals: [], lcov: '' };
  let head = opts.headSha;
  const versions = [{ id: 1, head_commit_sha: opts.headSha, base_commit_sha: opts.baseSha, start_commit_sha: opts.baseSha, created_at: '2026-09-20T10:00:00Z' }];
  let nextId = 100;
  let url = '';

  const mr = () => ({
    id: 1,
    iid: 1,
    project_id: 7,
    title: 'Add order pagination',
    description: '',
    state: 'opened',
    web_url: `${url}/acme/demo/-/merge_requests/1`,
    source_branch: 'feature',
    target_branch: 'main',
    sha: head,
    diff_refs: { base_sha: opts.baseSha, start_sha: opts.baseSha, head_sha: head },
    author: user,
    references: { full: 'acme/demo!1' },
  });

  const note = (body: string, position?: unknown) => ({
    id: nextId++,
    body,
    author: user,
    created_at: new Date().toISOString(),
    system: false,
    resolvable: !!position,
    resolved: false,
    position,
  });

  const routes: [string, RegExp, (m: RegExpMatchArray, body: any, q: URLSearchParams) => unknown][] = [
    ['GET', /^\/user$/, () => user],
    ['GET', /^\/projects\/(7|acme%2Fdemo)$/, () => project],
    ['GET', /^\/projects\/8$/, () => ({ id: 8, path_with_namespace: 'acme/web', http_url_to_repo: '', web_url: `${url}/acme/web` })],
    ['GET', /^\/groups\/acme\/search$/, (_, __, q) => {
      if (q.get('scope') !== 'blobs' || q.get('search') !== 'OrderDto') return [];
      const blob = (project_id: number, path: string, startline: number, data: string) => ({ basename: path, filename: path, path, ref: 'main', startline, data, project_id });
      return [
        blob(8, 'src/api.ts', 10, "import { OrderDto } from '@acme/api';\nconst dto: OrderDto = load();"),
        blob(8, 'src/v2.ts', 1, 'type OrderDtoV2 = {};'),
        blob(7, 'src/order.dto.ts', 1, 'export class OrderDto {'),
      ];
    }],
    ['GET', /^\/merge_requests$/, () => [mr()]],
    ['GET', /^\/groups$/, () => [{ id: 3, full_path: 'acme', name: 'Acme' }]],
    ['GET', /^\/groups\/(3|acme)\/merge_requests$/, () => [mr()]],
    ['GET', /^\/projects\/7\/merge_requests\/1$/, () => mr()],
    ['GET', /^\/projects\/7\/merge_requests\/1\/discussions$/, () => state.discussions],
    ['POST', /^\/projects\/7\/merge_requests\/1\/discussions$/, (_, b) => {
      const d = { id: `d${nextId++}`, individual_note: false, notes: [note(b.body, b.position)] };
      state.discussions.push(d);
      return d;
    }],
    ['POST', /^\/projects\/7\/merge_requests\/1\/discussions\/(\w+)\/notes$/, (m, b) => {
      const n = note(b.body);
      state.discussions.find((d) => d.id === m[1])?.notes.push(n);
      return n;
    }],
    ['PUT', /^\/projects\/7\/merge_requests\/1\/discussions\/(\w+)$/, (m, b) => {
      const d = state.discussions.find((x) => x.id === m[1]);
      d?.notes.forEach((n: any) => (n.resolved = b.resolved));
      return d;
    }],
    ['GET', /^\/projects\/7\/merge_requests\/1\/draft_notes$/, () => state.drafts],
    ['POST', /^\/projects\/7\/merge_requests\/1\/draft_notes$/, (_, b) => {
      const d = { id: nextId++, note: b.note, discussion_id: b.in_reply_to_discussion_id ?? null, position: b.position ?? null };
      state.drafts.push(d);
      return d;
    }],
    ['DELETE', /^\/projects\/7\/merge_requests\/1\/draft_notes\/(\d+)$/, (m) => {
      state.drafts = state.drafts.filter((d) => d.id !== Number(m[1]));
      return '';
    }],
    ['POST', /^\/projects\/7\/merge_requests\/1\/draft_notes\/bulk_publish$/, () => {
      for (const d of state.drafts) {
        state.discussions.push({ id: `d${nextId++}`, individual_note: false, notes: [note(d.note, d.position)] });
      }
      state.drafts = [];
      return '';
    }],
    ['GET', /^\/projects\/7\/merge_requests\/1\/approval_state$/, () => ({
      rules: [{ id: 1, name: 'Backend', rule_type: 'regular', approvals_required: 1, approved: false, approved_by: [], eligible_approvers: [user], code_owner: false }],
    })],
    ['GET', /^\/projects\/7\/merge_requests\/1\/pipelines$/, () => [{ id: 50, sha: head, status: 'failed', web_url: `${url}/p/50` }]],
    ['GET', /^\/projects\/7\/pipelines\/50\/jobs$/, () => [
      { id: 501, name: 'lint', stage: 'test', status: 'failed', web_url: `${url}/j/501` },
      { id: 502, name: 'test-affected', stage: 'test', status: 'success', web_url: `${url}/j/502`, artifacts: [{ file_type: 'archive', filename: 'artifacts.zip' }] },
    ]],
    ['GET', /^\/projects\/7\/jobs\/502\/artifacts\/coverage\/lcov\.info$/, () => ({ __text: state.lcov })],
    ['GET', /^\/projects\/7\/repository\/files\/([^/]+)\/raw$/, (m) =>
      decodeURIComponent(m[1]) === '.gitlab/CODEOWNERS' && state.codeowners ? { __text: state.codeowners } : { __status: 404 },
    ],
    ['GET', /^\/projects\/7\/merge_requests\/1\/versions$/, () => [...versions].reverse()],
    ['GET', /^\/projects\/7\/repository\/files\/([^/]+)\/blame$/, () => [
      { commit: { id: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00', message: 'Tweak totals\n\nlong body', author_name: 'Anna', authored_date: '2026-09-01T10:00:00Z' }, lines: ['x'] },
    ]],
    ['GET', /^\/projects\/7\/repository\/commits\/(\w+)\/merge_requests$/, () => [{ ...mr(), iid: 5, title: 'Older change', state: 'merged', web_url: `${url}/acme/demo/-/merge_requests/5` }]],
    ['GET', /^\/groups$/, () => [{ id: 3, full_path: 'acme', name: 'Acme' }]],
    ['POST', /^\/projects\/7\/merge_requests\/1\/approve$/, (_, b) => {
      state.approvals.push(b.sha);
      return { approved: true, approved_by: [{ user }] };
    }],
  ];

  const server: Server = createServer(async (req, res) => {
    const full = new URL(req.url ?? '/', 'http://fake');
    const path = full.pathname.replace(/^\/api\/v4/, '');
    const body = await readJson(req);
    for (const [method, re, handler] of routes) {
      const m = path.match(re);
      if (req.method === method && m) {
        const out = handler(m, body, full.searchParams) as any;
        if (out && typeof out === 'object' && '__status' in out) {
          res.writeHead(out.__status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'not found' }));
        } else if (out && typeof out === 'object' && '__text' in out) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(out.__text);
        } else {
          res.writeHead(out === '' ? 204 : 200, { 'Content-Type': 'application/json' });
          res.end(out === '' ? undefined : JSON.stringify(out));
        }
        return;
      }
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: `fake gitlab: no route ${req.method} ${path}` }));
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return Object.assign(state, {
    url,
    setHead(sha: string) {
      head = sha;
      versions.push({ id: versions.length + 1, head_commit_sha: sha, base_commit_sha: opts.baseSha, start_commit_sha: opts.baseSha, created_at: new Date().toISOString() });
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  }) as FakeGitLab;
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : {};
}
