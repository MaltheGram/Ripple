import * as path from 'node:path';
import { type NestRoute, parseNestRoutes, parseRtkEndpoints, type RtkEndpoint, routeScore, serviceFromConst } from '../core/endpoints';
import { appOf } from '../core/layers';
import { log, timed } from '../log';
import { git } from '../repo/git';
import { readWorktreeFile } from '../repo/safeRead';

export interface IndexedEndpoint extends RtkEndpoint {
  file: string;
  app: string;
  /** Service the endpoint talks to (from its baseUrl constant), e.g. `orders-service`. */
  service?: string;
}

export interface IndexedRoute extends NestRoute {
  file: string;
  app: string;
}

export interface HookUsage {
  file: string;
  /** 1-based. */
  line: number;
  hook: string;
}

/**
 * Every RTK Query endpoint and NestJS route in the MR checkout (the code *with* the MR's changes), so traces can
 * cross HTTP between frontends and services. Built with `git grep` + parsing; cached per MR version.
 */
export class RouteIndex {
  private constructor(
    private readonly worktree: string,
    readonly endpoints: IndexedEndpoint[],
    readonly routes: IndexedRoute[],
    private readonly apps: Set<string>,
  ) {}

  static async build(worktree: string): Promise<RouteIndex> {
    return timed('route index', async () => {
      const [apiFiles, controllerFiles] = await Promise.all([
        grepFiles(worktree, 'createApi\\(|injectEndpoints\\('),
        grepFiles(worktree, '@Controller\\('),
      ]);
      const parsed = await Promise.all(apiFiles.map(async (f) => ({ f, eps: parseRtkEndpoints(await read(worktree, f)) })));
      // injectEndpoints files have no baseUrl; inherit it from the createApi file in the same folder.
      const dirConst = new Map<string, string>();
      for (const p of parsed) for (const e of p.eps) if (e.baseUrlConst) dirConst.set(path.posix.dirname(p.f), e.baseUrlConst);
      const endpoints = parsed.flatMap((p) =>
        p.eps.map((e) => {
          const baseUrlConst = e.baseUrlConst ?? dirConst.get(path.posix.dirname(p.f));
          return { ...e, baseUrlConst, file: p.f, app: appOf(p.f), service: serviceFromConst(baseUrlConst) };
        }),
      );
      const routes = (
        await Promise.all(controllerFiles.map(async (f) => parseNestRoutes(await read(worktree, f)).map((r) => ({ ...r, file: f, app: appOf(f) }))))
      ).flat();
      log().info(`route index: ${endpoints.length} RTK endpoints, ${routes.length} routes`);
      return new RouteIndex(worktree, endpoints, routes, new Set(routes.map((r) => r.app)));
    });
  }

  /** Best-matching backend routes for a frontend endpoint (preferring the service its baseUrl points to). */
  routesFor(e: IndexedEndpoint): IndexedRoute[] {
    let cands = this.routes.map((r) => ({ r, s: routeScore(e.path, r.path, e.method, r.method) })).filter((x) => x.s >= 0);
    // Prefer routes in the service the baseUrl points to; otherwise any matching route in the repo.
    const inService = cands.filter((x) => x.r.app === e.service);
    if (inService.length) cands = inService;
    const best = Math.max(-1, ...cands.map((x) => x.s));
    return cands.filter((x) => x.s === best).map((x) => x.r);
  }

  /** Frontend endpoints that call a backend route. */
  endpointsFor(route: IndexedRoute): IndexedEndpoint[] {
    return this.endpoints.filter((e) => this.routesFor(e).includes(route));
  }

  /** The route whose handler is the method at `file:line` (1-based, anywhere in the method). */
  routeAt(file: string, handler: string): IndexedRoute | undefined {
    return this.routes.find((r) => r.file === file && r.handler === handler);
  }

  endpointAt(file: string, line: number): IndexedEndpoint | undefined {
    return this.endpoints.find((e) => e.file === file && e.line === line);
  }

  endpointByHook(hook: string): IndexedEndpoint | undefined {
    return this.endpoints.find((e) => e.hooks.includes(hook));
  }

  /** True when the endpoint's service is not part of this repository (and no route here matches). */
  isExternal(e: IndexedEndpoint): boolean {
    return !!e.service && !this.apps.has(e.service) && !this.routesFor(e).length;
  }

  /** Where a generated hook is called (excluding its own export line). */
  async hookUsages(e: IndexedEndpoint): Promise<HookUsage[]> {
    const out: HookUsage[] = [];
    for (const hook of e.hooks) {
      const res = await git(['grep', '-n', '-w', '-e', hook, '--', '*.ts', '*.tsx'], { cwd: this.worktree, allowFailure: true });
      for (const line of res.split('\n')) {
        const m = /^(.+?):(\d+):(.*)$/.exec(line);
        if (!m) continue;
        // Skip `export const { useXQuery } = api`, imports and bare names in multi-line import/export lists.
        if (/^\s*(export\s+const\s+\{|import\b|\}\s*from\b|export\s*\{)/.test(m[3]) || /^\s*[\w$]+\s*,?\s*$/.test(m[3]) || m[1] === e.file) continue;
        out.push({ file: m[1], line: Number(m[2]), hook });
      }
    }
    return out;
  }
}

async function grepFiles(worktree: string, pattern: string): Promise<string[]> {
  const out = await git(['grep', '-l', '-E', pattern, '--', '*.ts', '*.tsx'], { cwd: worktree, allowFailure: true });
  return out.split('\n').filter((f) => f && !/\.(spec|test)\.|__tests__|node_modules/.test(f));
}

async function read(worktree: string, file: string): Promise<string> {
  return (await readWorktreeFile(worktree, file)) ?? '';
}
