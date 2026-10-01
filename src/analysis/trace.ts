import * as path from 'node:path';
import * as vscode from 'vscode';
import { appOf, isEntryLayer, LAYER_LABEL, type Layer, layerOf } from '../core/layers';
import type { Hunk } from '../core/types';
import type { ReviewSession } from '../ui/session';
import { type IndexedEndpoint, RouteIndex } from './routeIndex';

export type TraceEdgeKind = 'calls' | 'renders' | 'http' | 'uses';

export interface TraceNode {
  id: string;
  name: string;
  container?: string;
  /** Worktree-relative path. */
  file: string;
  app: string;
  layer: Layer;
  /** 0-based line of the name. */
  line: number;
  /** Changed by this MR. */
  changed: boolean;
  role: 'target' | 'up' | 'down';
  /** Extra line, e.g. the HTTP route of an endpoint. */
  detail?: string;
  /** A service outside this repository (e.g. an identity provider). */
  external?: boolean;
  /** More callers/callees exist but were not loaded yet. */
  more: { up: boolean; down: boolean };
}

export interface TraceEdge {
  from: string;
  to: string;
  kind: TraceEdgeKind;
  label?: string;
}

export interface Trace {
  targetId: string;
  title: string;
  nodes: TraceNode[];
  edges: TraceEdge[];
  /** Lookups that failed (the trace may be incomplete there). */
  warnings: string[];
}

const UP_DEPTH = 4;
const DOWN_DEPTH = 2;
const MAX_UP = 40;
const MAX_DOWN = 25;
/** Per node, per direction; the rest shows as "more". */
const FAN_OUT = 8;
const FRONTEND_LEAF = new Set<Layer>(['component', 'hook', 'util', 'other']);
/** Order of callees when there are more than fit: API calls and backend layers first, UI details last. */
const RANK: Partial<Record<Layer, number>> = { api: 0, controller: 1, service: 1, repository: 2, entity: 2, job: 2, hook: 3, component: 4 };
const stepRank = (s: Step) => (s.edge.kind === 'http' || s.edge.kind === 'uses' ? -1 : (RANK[s.target.node.layer] ?? 5));

const HOOK_NAME = /\buse(?:Lazy)?[A-Z][\w$]*(?:Query|Mutation)\b/g;

type Internal =
  | { kind: 'fn'; node: TraceNode; item: vscode.CallHierarchyItem }
  | { kind: 'endpoint'; node: TraceNode; endpoint: IndexedEndpoint }
  | { kind: 'external'; node: TraceNode };

type Step = { target: Internal; edge: Omit<TraceEdge, 'from' | 'to'> };

const indexes = new WeakMap<ReviewSession, { headSha: string; index: Promise<RouteIndex> }>();

/** Route index for the session's current MR version (built once, reused by later traces). */
export function routeIndexFor(s: ReviewSession): Promise<RouteIndex> {
  const cached = indexes.get(s);
  if (cached?.headSha === s.refs.head_sha) return cached.index;
  const index = RouteIndex.build(s.entry.worktree);
  indexes.set(s, { headSha: s.refs.head_sha, index });
  index.catch(() => indexes.delete(s));
  return index;
}

/**
 * Trace of one function: who calls it (up to entry points such as controllers, components, jobs and tests) and what
 * it calls, following function calls, React renders, component → RTK hook → endpoint, and endpoint ⇄ controller
 * over HTTP. Language server + route index only; no AI.
 */
export class TraceBuilder {
  private readonly nodes = new Map<string, Internal>();
  private readonly edges = new Map<string, TraceEdge>();
  private targetId = '';
  private title = '';
  private readonly warnings: string[] = [];

  constructor(
    private readonly s: ReviewSession,
    private readonly index: RouteIndex,
  ) {}

  async start(uri: vscode.Uri, pos: vscode.Position): Promise<Trace> {
    // Right after opening an MR the language server may still be loading the project: give it a moment.
    let item = await enclosingItem(uri, pos);
    for (let i = 0; !item && i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      item = await enclosingItem(uri, pos);
    }
    if (!item) throw new Error('No function, method or component at the cursor (or the language server is not ready yet).');
    // Inside an RTK endpoint definition: the endpoint itself is the thing to trace.
    const rel = this.rel(uri);
    const ep = this.index.endpoints.find((e) => e.file === rel && e.line - 1 <= pos.line && pos.line - (e.line - 1) < 25 && item.range.contains(new vscode.Position(e.line - 1, 0)));
    const target = ep ? this.endpointNode(ep, 'target') : this.fnNode(item, 'target');
    this.targetId = target.node.id;
    this.title = label(target.node);
    await this.walk(target, 'up', UP_DEPTH, MAX_UP);
    await this.walk(target, 'down', DOWN_DEPTH, MAX_DOWN);
    return this.snapshot();
  }

  /** Load one more level of callers or callees for a node. */
  async expand(id: string, dir: 'up' | 'down'): Promise<Trace> {
    const n = this.nodes.get(id);
    if (n) await this.walk(n, dir, 1, FAN_OUT * 2);
    return this.snapshot();
  }

  private snapshot(): Trace {
    // Nodes looked up but cut by the fan-out limit have no edge: leave them out (the parent shows "+ more").
    const linked = new Set([this.targetId]);
    for (const e of this.edges.values()) linked.add(e.from).add(e.to);
    return {
      targetId: this.targetId,
      title: this.title,
      nodes: [...this.nodes.values()].map((n) => n.node).filter((n) => linked.has(n.id)),
      edges: [...this.edges.values()],
      warnings: [...new Set(this.warnings)],
    };
  }

  /** Nodes already expanded per direction ("id:up" / "id:down"). */
  private readonly expanded = new Set<string>();

  /** Breadth-first walk in one direction, bounded by depth and node budget. */
  private async walk(from: Internal, dir: 'up' | 'down', depth: number, budget: number) {
    let frontier = [from];
    const start = this.nodes.size;
    for (let d = 0; d < depth && frontier.length; d++) {
      const next: Internal[] = [];
      for (const n of frontier) {
        const key = `${n.node.id}:${dir}`;
        if (this.expanded.has(key)) continue;
        if (this.nodes.size - start >= budget) {
          n.node.more[dir] = true;
          continue;
        }
        // Tests, jobs, migrations: showing them is useful, walking past them is not.
        if (n !== from && dir === 'up' && isEntryLayer(n.node.layer)) continue;
        // Downstream, frontend children (components, hooks, helpers) are shown but not walked further: what matters is
        // which APIs the code hits and what those do on the backend. Endpoints always continue across HTTP.
        if (n !== from && dir === 'down' && n.kind === 'fn' && FRONTEND_LEAF.has(n.node.layer)) {
          n.node.more.down = true;
          continue;
        }
        this.expanded.add(key);
        const steps = await (dir === 'up' ? this.up(n) : this.down(n)).catch((e: unknown) => {
          this.warnings.push(`${label(n.node)} (${dir === 'up' ? 'callers' : 'callees'}): ${e instanceof Error ? e.message : String(e)}`);
          return [] as Step[];
        });
        n.node.more[dir] = steps.length > FAN_OUT;
        steps.sort((a, b) => stepRank(a) - stepRank(b));
        for (const step of steps.slice(0, FAN_OUT)) {
          const [a, b] = dir === 'up' ? [step.target.node.id, n.node.id] : [n.node.id, step.target.node.id];
          if (a !== b) this.edges.set(`${a}→${b}`, { from: a, to: b, ...step.edge });
          if (!this.expanded.has(`${step.target.node.id}:${dir}`)) next.push(step.target);
        }
      }
      frontier = next;
      // An endpoint at the depth limit still gets its HTTP hop, so a frontend trace always reaches the backend.
      if (d === depth - 1 && dir === 'down') {
        for (const ep of frontier.filter((x) => x.kind === 'endpoint' && !this.expanded.has(`${x.node.id}:down`))) {
          this.expanded.add(`${ep.node.id}:down`);
          for (const step of await this.down(ep).catch(() => [] as Step[])) {
            this.edges.set(`${ep.node.id}→${step.target.node.id}`, { from: ep.node.id, to: step.target.node.id, ...step.edge });
            step.target.node.more.down = true;
          }
        }
        frontier = frontier.filter((x) => x.kind !== 'endpoint');
      }
    }
    // Nodes at the edge of the walk may have more to show.
    for (const n of frontier) {
      if (this.expanded.has(`${n.node.id}:${dir}`) || n.kind === 'external') continue;
      if (dir === 'down' || !isEntryLayer(n.node.layer)) n.node.more[dir] = true;
    }
  }

  // ── callers ───────────────────────────────────────────────────────────────

  private async up(n: Internal): Promise<Step[]> {
    if (n.kind === 'external') return [];
    if (n.kind === 'endpoint') {
      const usages = await this.index.hookUsages(n.endpoint);
      const steps: Step[] = [];
      for (const u of usages) {
        const item = await enclosingItem(vscode.Uri.file(path.join(this.s.entry.worktree, u.file)), new vscode.Position(u.line - 1, 0));
        if (item) steps.push({ target: this.fnNode(item, 'up'), edge: { kind: 'uses', label: u.hook } });
      }
      return dedupe(steps);
    }

    const steps: Step[] = [];
    const calls = (await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', n.item)) ?? [];
    for (const c of calls) {
      if (!this.inRepo(c.from.uri)) continue;
      const t = this.fnNode(c.from, 'up');
      steps.push({ target: t, edge: { kind: n.node.layer === 'component' && t.node.layer === 'component' ? 'renders' : 'calls' } });
    }

    // React: <Component /> usages are renders, which call hierarchy may miss.
    if (n.node.layer === 'component') {
      const refs = (await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', n.item.uri, n.item.selectionRange.start)) ?? [];
      for (const r of refs) {
        if (!this.inRepo(r.uri)) continue;
        const doc = await vscode.workspace.openTextDocument(r.uri);
        if (!doc.lineAt(r.range.start.line).text.includes(`<${n.node.name}`)) continue;
        const item = await enclosingItem(r.uri, r.range.start);
        if (item) steps.push({ target: this.fnNode(item, 'up'), edge: { kind: 'renders' } });
      }
    }

    // Backend handler ← frontend endpoints over HTTP.
    const route = this.index.routeAt(n.node.file, n.node.name);
    if (route) {
      n.node.detail = `${route.method} ${route.path}`;
      for (const e of this.index.endpointsFor(route)) {
        steps.push({ target: this.endpointNode(e, 'up'), edge: { kind: 'http', label: `${route.method} ${route.path}` } });
      }
    }
    return dedupe(steps);
  }

  // ── callees ───────────────────────────────────────────────────────────────

  private async down(n: Internal): Promise<Step[]> {
    if (n.kind === 'external') return [];
    if (n.kind === 'endpoint') {
      const routes = this.index.routesFor(n.endpoint);
      if (!routes.length && this.index.isExternal(n.endpoint)) {
        const svc = n.endpoint.service!;
        return [{ target: this.externalNode(svc), edge: { kind: 'http', label: `${n.endpoint.method} ${n.endpoint.path}` } }];
      }
      const steps: Step[] = [];
      for (const r of routes) {
        const uri = vscode.Uri.file(path.join(this.s.entry.worktree, r.file));
        const doc = await vscode.workspace.openTextDocument(uri);
        const col = Math.max(0, doc.lineAt(r.line - 1).text.indexOf(r.handler));
        const [item] = (await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', uri, new vscode.Position(r.line - 1, col))) ?? [];
        if (item) {
          const t = this.fnNode(item, 'down');
          t.node.detail = `${r.method} ${r.path}`;
          steps.push({ target: t, edge: { kind: 'http', label: `${r.method} ${r.path}` } });
        }
      }
      return steps;
    }

    const steps: Step[] = [];
    const seenHooks = new Set<string>();
    const calls = (await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>('vscode.provideOutgoingCalls', n.item)) ?? [];
    for (const c of calls) {
      const e = this.index.endpointByHook(c.to.name);
      if (e) {
        seenHooks.add(c.to.name);
        steps.push({ target: this.endpointNode(e, 'down'), edge: { kind: 'uses', label: c.to.name } });
        continue;
      }
      if (!this.inRepo(c.to.uri)) continue;
      const t = this.fnNode(c.to, 'down');
      steps.push({ target: t, edge: { kind: n.node.layer === 'component' && t.node.layer === 'component' ? 'renders' : 'calls' } });
    }

    // Generated RTK hooks are destructured exports, which call hierarchy often can't resolve: find them by name.
    const doc = await vscode.workspace.openTextDocument(n.item.uri);
    const body = doc.getText(n.item.range);
    for (const m of body.matchAll(HOOK_NAME)) {
      if (seenHooks.has(m[0])) continue;
      const e = this.index.endpointByHook(m[0]);
      if (!e) continue;
      seenHooks.add(m[0]);
      steps.push({ target: this.endpointNode(e, 'down'), edge: { kind: 'uses', label: m[0] } });
    }
    return dedupe(steps);
  }

  // ── nodes ─────────────────────────────────────────────────────────────────

  private fnNode(item: vscode.CallHierarchyItem, role: TraceNode['role']): Internal {
    const id = `${item.uri.fsPath}:${item.selectionRange.start.line}:${item.selectionRange.start.character}`;
    const existing = this.nodes.get(id);
    if (existing) return existing;
    const file = this.rel(item.uri);
    const container = containerOf(item);
    const topLevel = item.kind === vscode.SymbolKind.File || item.kind === vscode.SymbolKind.Module;
    const node: TraceNode = {
      id,
      name: topLevel ? `${path.posix.basename(file)} (top level)` : item.name,
      container: topLevel ? undefined : container,
      file,
      app: appOf(file),
      layer: layerOf(file, item.name, container),
      line: item.selectionRange.start.line,
      changed: this.changed(file, item.range.start.line + 1, item.range.end.line + 1),
      role,
      more: { up: false, down: false },
    };
    const n: Internal = { kind: 'fn', node, item };
    this.nodes.set(id, n);
    return n;
  }

  private endpointNode(e: IndexedEndpoint, role: TraceNode['role']): Internal {
    const id = `ep:${e.file}:${e.line}`;
    const existing = this.nodes.get(id);
    if (existing) return existing;
    const node: TraceNode = {
      id,
      name: e.name,
      container: e.hooks[0],
      file: e.file,
      app: e.app,
      layer: 'api',
      line: e.line - 1,
      changed: this.changed(e.file, e.line, e.line + 3),
      role,
      detail: `${e.method} ${e.path}${e.service ? ` → ${e.service}` : ''}`,
      more: { up: false, down: false },
    };
    const n: Internal = { kind: 'endpoint', node, endpoint: e };
    this.nodes.set(id, n);
    return n;
  }

  private externalNode(service: string): Internal {
    const id = `ext:${service}`;
    const existing = this.nodes.get(id);
    if (existing) return existing;
    const node: TraceNode = {
      id,
      name: service,
      file: '',
      app: service,
      layer: 'other',
      line: 0,
      changed: false,
      role: 'down',
      detail: 'external service (not in this repository)',
      external: true,
      more: { up: false, down: false },
    };
    const n: Internal = { kind: 'external', node };
    this.nodes.set(id, n);
    return n;
  }

  private changed(file: string, start: number, end: number): boolean {
    const f = this.s.files.find((x) => x.path === file && x.change !== 'deleted');
    return !!f && (f.change === 'added' || f.hunks.some((h) => overlaps(h, start, end)));
  }

  private inRepo(uri: vscode.Uri): boolean {
    return uri.scheme === 'file' && uri.fsPath.startsWith(this.s.entry.worktree + path.sep) && !uri.fsPath.includes(`${path.sep}node_modules${path.sep}`);
  }

  private rel(uri: vscode.Uri): string {
    return path.relative(this.s.entry.worktree, uri.fsPath).split(path.sep).join('/');
  }
}

const CALLABLE = new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor]);
const MAYBE_CALLABLE = new Set([vscode.SymbolKind.Variable, vscode.SymbolKind.Constant, vscode.SymbolKind.Property, vscode.SymbolKind.Field]);

/** Call hierarchy item of the smallest function/method/component (incl. `const X = () => …`) containing `pos`. */
export async function enclosingItem(uri: vscode.Uri, pos: vscode.Position): Promise<vscode.CallHierarchyItem | undefined> {
  const roots = (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri)) ?? [];
  let best: vscode.DocumentSymbol | undefined;
  const visit = (syms: vscode.DocumentSymbol[]) => {
    for (const sym of syms) {
      if (!sym.range.contains(pos)) continue;
      const callable = CALLABLE.has(sym.kind) || (MAYBE_CALLABLE.has(sym.kind) && sym.range.end.line > sym.range.start.line);
      if (callable) best = sym;
      if ('children' in sym) visit(sym.children);
    }
  };
  if (roots.length && 'children' in roots[0]) visit(roots);
  const at = best?.selectionRange.start ?? pos;
  const [item] = (await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', uri, at)) ?? [];
  return item;
}

function containerOf(item: vscode.CallHierarchyItem): string | undefined {
  return item.detail && !item.detail.includes('/') && !item.detail.includes(' ') && !item.detail.includes('.') ? item.detail : undefined;
}

function overlaps(h: Hunk, start: number, end: number): boolean {
  const s = h.newLines > 0 ? h.newStart : h.newStart + 1;
  const e = h.newLines > 0 ? h.newStart + h.newLines - 1 : h.newStart + 1;
  return e >= start && s <= end;
}

function dedupe(steps: Step[]): Step[] {
  const seen = new Set<string>();
  return steps.filter((s) => (seen.has(s.target.node.id) ? false : (seen.add(s.target.node.id), true)));
}

export function label(n: TraceNode): string {
  return n.container && n.layer !== 'api' ? `${n.container}.${n.name}` : n.name;
}

/** Mermaid flowchart grouped by app, with edge labels (for the MR description). */
export function traceToMermaid(t: Trace): string {
  const ids = new Map(t.nodes.map((n, i) => [n.id, `n${i}`]));
  const byApp = new Map<string, TraceNode[]>();
  for (const n of t.nodes) {
    if (!byApp.has(n.app)) byApp.set(n.app, []);
    byApp.get(n.app)!.push(n);
  }
  const esc = (s: string) => s.replace(/"/g, '#quot;');
  const lines = ['flowchart LR'];
  let g = 0;
  for (const [app, nodes] of byApp) {
    lines.push(`  subgraph g${g++}["${esc(app)}"]`);
    for (const n of nodes) {
      const text = `${label(n)}<br/><small>${LAYER_LABEL[n.layer]}${n.changed ? ' · changed' : ''}</small>`;
      lines.push(`    ${ids.get(n.id)}["${esc(text)}"]${n.id === t.targetId ? ':::target' : n.changed ? ':::changed' : ''}`);
    }
    lines.push('  end');
  }
  for (const e of t.edges) {
    const arrow = e.kind === 'http' ? '-.->' : e.kind === 'renders' ? '==>' : '-->';
    lines.push(`  ${ids.get(e.from)} ${arrow}${e.label ? `|${esc(e.label)}|` : ''} ${ids.get(e.to)}`);
  }
  lines.push('  classDef target stroke:#0e639c,stroke-width:3px', '  classDef changed fill:#fff1c2,stroke:#d4a72c');
  return lines.join('\n');
}
