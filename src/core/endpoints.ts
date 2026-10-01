// Pure parsing of HTTP boundaries so a trace can cross from frontend to backend:
// RTK Query `createApi` endpoints (frontend) and NestJS controller routes (backend).

export interface RtkEndpoint {
  /** Endpoint name, e.g. `getOrders`. */
  name: string;
  kind: 'query' | 'mutation';
  method: string;
  /** Normalised path with `:p` for template params, e.g. `/orders/:p/stats`. */
  path: string;
  /** 1-based line of the endpoint definition. */
  line: number;
  /** `baseUrl` constant, e.g. `ORDERS_SERVICE_URL`. */
  baseUrlConst?: string;
  /** Generated hooks, e.g. `useGetOrdersQuery`, `useLazyGetOrdersQuery`. */
  hooks: string[];
}

export interface NestRoute {
  method: string;
  /** e.g. `/orders/:id/stats`. */
  path: string;
  /** Handler method name. */
  handler: string;
  controller?: string;
  /** 1-based line of the handler method. */
  line: number;
}

const ENDPOINT_START = /^\s*([A-Za-z_$][\w$]*)\s*:\s*build\.(query|mutation)\b/;
const STRING = String.raw`(\x60[^\x60]*\x60|'[^']*'|"[^"]*")`;
const URL_PROP = new RegExp(String.raw`\burl:\s*${STRING}`);
const QUERY_STRING = new RegExp(String.raw`\bquery:\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*${STRING}`);
const METHOD = /\bmethod:\s*['"`]([A-Za-z]+)['"`]/;
const BASE_URL = /\bbaseUrl:\s*([A-Z][A-Z0-9_]*)/;

/** Endpoints of RTK Query `createApi` / `injectEndpoints` calls in one file. */
export function parseRtkEndpoints(text: string): RtkEndpoint[] {
  const lines = text.split('\n');
  const baseUrlConst = lines.map((l) => BASE_URL.exec(l)?.[1]).find(Boolean);
  const starts: { i: number; name: string; kind: 'query' | 'mutation' }[] = [];
  lines.forEach((l, i) => {
    const m = ENDPOINT_START.exec(l);
    if (m) starts.push({ i, name: m[1], kind: m[2] as 'query' | 'mutation' });
  });
  return starts.map((s, n) => {
    const block = lines.slice(s.i, starts[n + 1]?.i ?? Math.min(lines.length, s.i + 40)).join('\n');
    const raw = URL_PROP.exec(block)?.[1] ?? QUERY_STRING.exec(block)?.[1] ?? '';
    const cap = s.name[0].toUpperCase() + s.name.slice(1);
    return {
      name: s.name,
      kind: s.kind,
      method: (METHOD.exec(block)?.[1] ?? 'GET').toUpperCase(),
      path: normalizeUrl(raw),
      line: s.i + 1,
      baseUrlConst,
      hooks: s.kind === 'query' ? [`use${cap}Query`, `useLazy${cap}Query`] : [`use${cap}Mutation`],
    };
  });
}

/** `\`${BASE}orders/${id}/stats?x=1\`` → `/orders/:p/stats`. A leading `${…}` is treated as the base URL. */
export function normalizeUrl(raw: string): string {
  let s = raw.replace(/^[`'"]|[`'"]$/g, '');
  s = s.replace(/^\$\{[^}]*\}/, '');
  s = s.split('?')[0];
  const segments = s
    .split('/')
    .filter(Boolean)
    .map((seg) => (/\$\{/.test(seg) ? ':p' : seg));
  return '/' + segments.join('/');
}

const HTTP_DECORATOR = /@(Get|Post|Put|Patch|Delete|All|Head|Options)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/;
const CONTROLLER = /@Controller\(\s*(?:\{[^}]*path:\s*)?['"`]([^'"`]*)['"`]/;
const CLASS = /\bclass\s+([A-Za-z_$][\w$]*)/;
const METHOD_DECL = /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*[(<]/;

/** Routes of a NestJS controller file. */
export function parseNestRoutes(text: string): NestRoute[] {
  const lines = text.split('\n');
  const prefix = lines.map((l) => CONTROLLER.exec(l)?.[1]).find((p) => p !== undefined);
  if (prefix === undefined) return [];
  const controller = lines.map((l) => CLASS.exec(l)?.[1]).find(Boolean);
  const out: NestRoute[] = [];
  let pending: { method: string; sub: string; since: number } | undefined;
  let depth = 0; // inside a multi-line decorator argument, e.g. @ApiOperation({ … })
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = HTTP_DECORATOR.exec(line);
    if (m) {
      pending = { method: m[1].toUpperCase(), sub: m[2] ?? '', since: i };
      depth = 0;
      continue;
    }
    if (!pending) continue;
    if (i - pending.since > 30) {
      pending = undefined;
      continue;
    }
    const t = line.trim();
    const opens = (t.match(/[({[]/g) ?? []).length - (t.match(/[)}\]]/g) ?? []).length;
    if (t.startsWith('@') || depth > 0) {
      depth = Math.max(0, depth + opens);
      continue;
    }
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    const decl = METHOD_DECL.exec(line);
    if (decl) {
      out.push({ method: pending.method, path: joinPath(prefix, pending.sub), handler: decl[1], controller, line: i + 1 });
      pending = undefined;
    }
  }
  return out;
}

function joinPath(...parts: string[]): string {
  return '/' + parts.flatMap((p) => p.split('/')).filter(Boolean).join('/');
}

const PREFIXES = new Set(['api', 'v1', 'v2', 'v3', 'public', 'internal', 'rest']);

/**
 * How well a frontend URL (normalised, `:p` params) matches a backend route (`:name` params); -1 = no match.
 * Segments are compared from the end so a global prefix (`/api`, `/v1`) on either side is tolerated.
 * Exact literal segments score highest, so `/accounts/:p` prefers `/accounts/:id` over `/accounts/options`.
 */
export function routeScore(frontend: string, backend: string, frontendMethod: string, backendMethod: string): number {
  if (backendMethod !== 'ALL' && frontendMethod !== backendMethod) return -1;
  const f = frontend.split('/').filter(Boolean);
  const b = backend.split('/').filter(Boolean);
  if (!f.length || !b.length) return -1;
  const longer = f.length > b.length ? f : b;
  const extra = longer.slice(0, Math.abs(f.length - b.length));
  if (!extra.every((seg) => PREFIXES.has(seg.toLowerCase()))) return -1;
  let score = 0;
  let literals = 0;
  for (let k = 1; k <= Math.min(f.length, b.length); k++) {
    const fs = f[f.length - k];
    const bs = b[b.length - k];
    const fParam = fs === ':p';
    const bParam = bs.startsWith(':');
    if (!fParam && !bParam) {
      if (fs.toLowerCase() !== bs.toLowerCase()) return -1;
      score += 3;
      literals++;
    } else if (fParam && bParam) score += 2;
    else if (bParam) score += 1;
    // A frontend param facing a backend literal is possible (`${'options'}`) but unlikely: no points.
  }
  return literals ? score : -1;
}

/** Convenience: does the frontend URL hit the backend route at all? */
export function routeMatches(frontend: string, backend: string, frontendMethod: string, backendMethod: string): boolean {
  return routeScore(frontend, backend, frontendMethod, backendMethod) >= 0;
}

/** `ORDERS_SERVICE_URL` → `orders-service` (to prefer routes in that app). */
export function serviceFromConst(c: string | undefined): string | undefined {
  if (!c) return undefined;
  const m = /^([A-Z0-9_]+?)_(?:API_)?(?:BASE_)?URL$/.exec(c);
  return m ? m[1].toLowerCase().replace(/_/g, '-') : undefined;
}
