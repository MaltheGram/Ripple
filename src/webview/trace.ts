// Runs inside the trace webview (browser). The extension sends a trace of one function (callers ← function → callees);
// ELK lays it out with one box per app/service; we render HTML cards + SVG edges with our own pan/zoom.
import ELK, { type ElkExtendedEdge, type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { Trace, TraceNode } from '../analysis/trace';
import { LAYER_LABEL, type Layer } from '../core/layers';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): unknown; setState(s: unknown): void };

const vscode = acquireVsCodeApi();
const elk = new ELK();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let trace: Trace = { targetId: '', title: '', nodes: [], edges: [], warnings: [] };
let viewed = new Set<string>();
let showTests = ((vscode.getState() as { showTests?: boolean } | undefined)?.showTests ?? true) as boolean;
let selected: string | undefined;
let hits: string[] = [];
let hitIndex = 0;
let byId = new Map<string, TraceNode>();
let outEdges = new Map<string, Set<string>>();
let inEdges = new Map<string, Set<string>>();
const positions = new Map<string, { x: number; y: number; w: number; h: number }>();
let view = { x: 40, y: 40, k: 1 };
let layoutRun = 0;

const NODE_W = 240;
const LAYER_COLOR: Record<Layer, string> = {
  component: 'frontend',
  hook: 'frontend',
  api: 'api',
  controller: 'controller',
  service: 'service',
  repository: 'data',
  entity: 'data',
  dto: 'data',
  migration: 'data',
  job: 'data',
  module: 'other',
  test: 'test',
  util: 'other',
  other: 'other',
};

// ── messages ───────────────────────────────────────────────────────────────
window.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.type === 'loading') showOverlay(`<div class="spinner"></div><div>${esc(msg.text)}</div>`);
  if (msg.type === 'error') showOverlay(`<div><b>Could not trace.</b><br>${esc(msg.text)}</div>`);
  if (msg.type === 'trace') {
    viewed = new Set(msg.viewedFiles ?? []);
    if (!msg.keepView) selected = undefined;
    setTrace(msg.trace, !!msg.keepView);
  }
  if (msg.type === 'viewed') {
    viewed = new Set(msg.viewedFiles);
    paint();
  }
});

// ── toolbar ────────────────────────────────────────────────────────────────
$('fit').onclick = () => fit();
$('zoomIn').onclick = () => zoomBy(1.2);
$('zoomOut').onclick = () => zoomBy(1 / 1.2);
$('mermaid').onclick = () => vscode.postMessage({ type: 'mermaid', ids: visibleNodes().map((n) => n.id) });
$('tests').setAttribute('aria-pressed', String(showTests));
$('tests').onclick = () => {
  showTests = !showTests;
  $('tests').setAttribute('aria-pressed', String(showTests));
  vscode.setState({ showTests });
  void relayout(false);
};
const search = $<HTMLInputElement>('search');
search.oninput = () => runSearch();
search.onkeydown = (e) => {
  if (e.key === 'Enter' && hits.length) {
    hitIndex = (hitIndex + (e.shiftKey ? hits.length - 1 : 1)) % hits.length;
    select(hits[hitIndex], true);
  }
  if (e.key === 'Escape') {
    search.value = '';
    runSearch();
    search.blur();
  }
};
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === '/') {
    e.preventDefault();
    search.focus();
  } else if (e.key === 'f' || e.key === 'F') fit();
  else if (e.key === '+' || e.key === '=') zoomBy(1.2);
  else if (e.key === '-') zoomBy(1 / 1.2);
  else if (e.key === 'Escape') select(undefined, false);
  else if (e.key === 'Enter' && selected) vscode.postMessage({ type: 'open', id: selected });
});

// ── state ──────────────────────────────────────────────────────────────────
function setTrace(t: Trace, keepView: boolean) {
  trace = t;
  byId = new Map(t.nodes.map((n) => [n.id, n]));
  outEdges = new Map();
  inEdges = new Map();
  for (const e of t.edges) {
    (outEdges.get(e.from) ?? outEdges.set(e.from, new Set()).get(e.from)!).add(e.to);
    (inEdges.get(e.to) ?? inEdges.set(e.to, new Set()).get(e.to)!).add(e.from);
  }
  if (selected && !byId.has(selected)) selected = undefined;
  void relayout(keepView);
}

function visibleNodes(): TraceNode[] {
  return trace.nodes.filter((n) => showTests || n.layer !== 'test' || n.id === trace.targetId);
}

/** Everything upstream and downstream of a node (for highlighting its paths). */
function chain(id: string): Set<string> {
  const out = new Set([id]);
  const walk = (from: string, edges: Map<string, Set<string>>) => {
    for (const next of edges.get(from) ?? []) if (!out.has(next)) (out.add(next), walk(next, edges));
  };
  walk(id, outEdges);
  walk(id, inEdges);
  return out;
}

// ── layout ─────────────────────────────────────────────────────────────────
async function relayout(keepView: boolean) {
  const run = ++layoutRun;
  const nodes = visibleNodes();
  const ids = new Set(nodes.map((n) => n.id));
  const edges = trace.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  updateStats();

  const world = $('world');
  world.querySelectorAll('.node, .app, .edge-label').forEach((el) => el.remove());
  if (!nodes.length) {
    $('edges').innerHTML = '';
    showOverlay('<div><b>Nothing to show.</b></div>');
    return;
  }
  hideOverlay();

  const cards = new Map<string, HTMLElement>();
  for (const n of nodes) {
    const el = card(n);
    world.appendChild(el);
    cards.set(n.id, el);
  }

  const apps = [...new Set(nodes.map((n) => n.app))];
  const root: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.spacing.nodeNodeBetweenLayers': '80',
      'elk.spacing.nodeNode': '16',
      'elk.spacing.edgeNode': '14',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.mergeEdges': 'true',
      'elk.edgeLabels.placement': 'CENTER',
      'elk.spacing.edgeLabel': '4',
    },
    children: apps.map((app) => ({
      id: `app:${app}`,
      layoutOptions: { 'elk.padding': '[top=30,left=14,bottom=14,right=14]' },
      children: nodes.filter((n) => n.app === app).map((n) => ({ id: n.id, width: NODE_W, height: cards.get(n.id)!.offsetHeight })),
    })),
    // HTTP routes are labelled; ELK reserves room for the label so it never covers a card.
    edges: edges.map((e, i): ElkExtendedEdge => ({
      id: `e${i}`,
      sources: [e.from],
      targets: [e.to],
      ...(e.label && e.kind === 'http' ? { labels: [{ id: `l${i}`, text: e.label, width: labelWidth(e.label), height: 18 }] } : {}),
    })),
  };

  let laid: ElkNode;
  try {
    laid = await elk.layout(root);
  } catch (err) {
    showOverlay(`<div><b>Layout failed.</b><br>${esc(String(err))}</div>`);
    return;
  }
  if (run !== layoutRun) return;

  positions.clear();
  for (const g of laid.children ?? []) {
    const box = document.createElement('div');
    box.className = 'app';
    Object.assign(box.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.width}px`, height: `${g.height}px` });
    box.dataset.app = g.id.slice(4);
    const lbl = document.createElement('div');
    lbl.className = 'app-label';
    lbl.textContent = g.id.slice(4);
    box.appendChild(lbl);
    world.prepend(box);
    for (const c of g.children ?? []) {
      const x = (g.x ?? 0) + (c.x ?? 0);
      const y = (g.y ?? 0) + (c.y ?? 0);
      positions.set(c.id, { x, y, w: c.width ?? NODE_W, h: c.height ?? 60 });
      const el = cards.get(c.id)!;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    }
  }
  drawEdges(laid, edges);
  paint();
  renderDetails();
  if (!keepView) fit();
  // Lets visual tests know the layout is on screen.
  document.body.dataset.layout = String(run);
}

function card(n: TraceNode): HTMLElement {
  const el = document.createElement('div');
  el.className = `node L-${LAYER_COLOR[n.layer]}${n.id === trace.targetId ? ' target' : ''}${n.external ? ' external' : ''}`;
  el.dataset.id = n.id;
  el.dataset.app = n.app;
  // For endpoints the "container" is the generated hook, which is how components use it.
  const where = n.external ? 'outside this repository' : `${n.container ? `${esc(n.container)} · ` : ''}${esc(basename(n.file))}:${n.line + 1}`;
  el.innerHTML = `
    <div class="row"><span class="layer">${n.external ? 'External' : LAYER_LABEL[n.layer]}</span><span class="spacer"></span>
      ${n.id === trace.targetId ? '<span class="tag tracing">tracing</span>' : ''}${n.changed ? '<span class="tag changed">changed</span>' : ''}</div>
    <div class="name" title="${esc(n.name)}">${esc(n.name)}</div>
    <div class="meta" title="${esc(n.file)}:${n.line + 1}">${where}</div>
    ${n.detail ? `<div class="detail" title="${esc(n.detail)}">${esc(n.detail)}</div>` : ''}`;
  if (n.more.up) el.appendChild(expander('l', 'up', n.id));
  if (n.more.down) el.appendChild(expander('r', 'down', n.id));
  el.onclick = (e) => {
    e.stopPropagation();
    select(n.id, false);
  };
  el.ondblclick = (e) => {
    e.stopPropagation();
    vscode.postMessage({ type: 'open', id: n.id });
  };
  return el;
}

function expander(side: 'l' | 'r', dir: 'up' | 'down', id: string): HTMLElement {
  const b = document.createElement('button');
  b.className = `exp ${side}`;
  b.textContent = '+';
  b.title = dir === 'up' ? 'Load more callers' : 'Load more callees';
  b.onclick = (e) => {
    e.stopPropagation();
    b.textContent = '…';
    vscode.postMessage({ type: 'expand', id, dir });
  };
  return b;
}

function drawEdges(laid: ElkNode, edges: Trace['edges']) {
  const svg = $('edges');
  const world = $('world');
  let maxX = 0;
  let maxY = 0;
  for (const g of laid.children ?? []) {
    maxX = Math.max(maxX, (g.x ?? 0) + (g.width ?? 0));
    maxY = Math.max(maxY, (g.y ?? 0) + (g.height ?? 0));
  }
  svg.setAttribute('width', String(maxX + 40));
  svg.setAttribute('height', String(maxY + 40));
  // ELK reports an edge relative to its container: edges inside one app box are relative to that box.
  const boxOf = new Map<string, { x: number; y: number }>();
  for (const g of laid.children ?? []) for (const c of g.children ?? []) boxOf.set(c.id, { x: g.x ?? 0, y: g.y ?? 0 });
  const paths: string[] = [];
  (laid.edges ?? []).forEach((le, i) => {
    const s = le.sections?.[0];
    const e = edges[i];
    if (!s || !e) return;
    const container = (le as { container?: string }).container;
    const a = boxOf.get(e.from);
    const b = boxOf.get(e.to);
    const inner = container ? container !== 'root' : !!a && !!b && a === b;
    const off = inner ? (container ? boxOf.get(e.from)! : a!) : { x: 0, y: 0 };
    const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => ({ x: p.x + off.x, y: p.y + off.y }));
    paths.push(`<path class="edge ${e.kind}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="${rounded(pts)}" marker-end="url(#arrow)"/>`);
    // Only HTTP routes get a label (placed by ELK); hook names are on the endpoint card.
    const lab = le.labels?.[0];
    if (lab && e.label && e.kind === 'http') {
      const l = document.createElement('div');
      l.className = `edge-label ${e.kind}`;
      l.dataset.from = e.from;
      l.dataset.to = e.to;
      l.textContent = e.label;
      Object.assign(l.style, { left: `${(lab.x ?? 0) + off.x + (lab.width ?? 0) / 2}px`, top: `${(lab.y ?? 0) + off.y + (lab.height ?? 0) / 2}px` });
      world.appendChild(l);
    }
  });
  svg.innerHTML = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker></defs>${paths.join('')}`;
}

/** Width of an edge label in the 10px monospace used for routes (+ padding). */
function labelWidth(text: string): number {
  return Math.ceil(text.length * 6.1) + 16;
}

function rounded(pts: { x: number; y: number }[], r = 8): string {
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [a, b, c] = [pts[i - 1], pts[i], pts[i + 1]];
    const r1 = Math.min(r, Math.hypot(a.x - b.x, a.y - b.y) / 2, Math.hypot(b.x - c.x, b.y - c.y) / 2);
    const p1 = toward(b, a, r1);
    const p2 = toward(b, c, r1);
    d += ` L${p1.x},${p1.y} Q${b.x},${b.y} ${p2.x},${p2.y}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${last.x},${last.y}`;
}
const toward = (from: { x: number; y: number }, to: { x: number; y: number }, len: number) => {
  const d = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  return { x: from.x + ((to.x - from.x) / d) * len, y: from.y + ((to.y - from.y) / d) * len };
};

// ── selection, search, details ─────────────────────────────────────────────
function paint() {
  const hot = selected ? chain(selected) : undefined;
  const hitSet = new Set(hits);
  document.querySelectorAll<HTMLElement>('.node').forEach((el) => {
    const id = el.dataset.id!;
    const n = byId.get(id);
    el.classList.toggle('selected', id === selected);
    el.classList.toggle('dim', (!!hot && !hot.has(id)) || (hits.length > 0 && !hitSet.has(id) && !hot));
    el.classList.toggle('hit', hitSet.has(id));
    el.classList.toggle('viewed', !!n && viewed.has(n.file));
  });
  const dimEdge = (from: string, to: string) => (hot ? !(hot.has(from) && hot.has(to)) : hits.length > 0 && !(hitSet.has(from) && hitSet.has(to)));
  document.querySelectorAll<SVGPathElement>('.edge').forEach((p) => {
    p.classList.toggle('hot', !!hot && hot.has(p.dataset.from!) && hot.has(p.dataset.to!));
    p.classList.toggle('dim', dimEdge(p.dataset.from!, p.dataset.to!));
  });
  document.querySelectorAll<HTMLElement>('.edge-label').forEach((l) => l.classList.toggle('dim', dimEdge(l.dataset.from!, l.dataset.to!)));
}

function select(id: string | undefined, center: boolean) {
  selected = id;
  paint();
  renderDetails();
  if (id && center) centerOn(id);
}

function runSearch() {
  const q = search.value.trim().toLowerCase();
  hits = q ? visibleNodes().filter((n) => `${n.container ?? ''}.${n.name} ${n.file} ${n.detail ?? ''}`.toLowerCase().includes(q)).map((n) => n.id) : [];
  hitIndex = 0;
  paint();
  if (hits.length) centerOn(hits[0]);
}

function renderDetails() {
  const aside = $('details');
  const n = selected ? byId.get(selected) : undefined;
  if (!n) {
    aside.classList.remove('open');
    return;
  }
  aside.classList.add('open');
  const list = (ids: Set<string> | undefined, dir: 'up' | 'down') => {
    const items = [...(ids ?? [])].map((i) => byId.get(i)).filter((x): x is TraceNode => !!x);
    const more = n.more[dir] ? `<li data-expand="${dir}"><span class="n">Load more…</span></li>` : '';
    if (!items.length && !more) return '<div class="empty-list">None found</div>';
    return `<ul>${items
      .map((i) => `<li class="L-${LAYER_COLOR[i.layer]}" data-go="${esc(i.id)}"><i class="dot"></i><span class="n">${esc(nameOf(i))}</span><span class="t">${LAYER_LABEL[i.layer]}</span></li>`)
      .join('')}${more}</ul>`;
  };
  aside.innerHTML = `
    <button class="close icon" data-close title="Close (Esc)">✕</button>
    <span class="layer L-${LAYER_COLOR[n.layer]}" style="color: var(--k)">${n.external ? 'External' : LAYER_LABEL[n.layer]}</span>
    ${n.changed ? ' <span class="tag changed">changed in this MR</span>' : ''}
    <h2>${esc(nameOf(n))}</h2>
    <div class="sub">${n.external ? 'outside this repository' : `${esc(n.app)} · ${esc(n.file)}:${n.line + 1}`}</div>
    ${n.detail ? `<div class="sub" style="color: var(--l-api)">${esc(n.detail)}</div>` : ''}
    <div class="actions">
      ${n.external ? '' : `<button class="primary" data-open>${n.changed ? 'Open diff' : 'Open file'}</button>`}
      ${n.external || n.id === trace.targetId ? '' : '<button data-retrace title="Start a new trace from this function">Trace from here</button>'}
      ${n.changed ? `<button data-viewed>${viewed.has(n.file) ? '✓ File viewed' : 'Mark file viewed'}</button>` : ''}
    </div>
    <h3>Called by</h3>${list(inEdges.get(n.id), 'up')}
    <h3>Calls</h3>${list(outEdges.get(n.id), 'down')}`;
  aside.querySelector('[data-close]')?.addEventListener('click', () => select(undefined, false));
  aside.querySelector('[data-open]')?.addEventListener('click', () => vscode.postMessage({ type: 'open', id: n.id }));
  aside.querySelector('[data-retrace]')?.addEventListener('click', () => vscode.postMessage({ type: 'retrace', id: n.id }));
  aside.querySelector('[data-viewed]')?.addEventListener('click', () => vscode.postMessage({ type: 'markViewed', file: n.file, viewed: !viewed.has(n.file) }));
  aside.querySelectorAll<HTMLElement>('[data-go]').forEach((li) => (li.onclick = () => select(li.dataset.go, true)));
  aside.querySelectorAll<HTMLElement>('[data-expand]').forEach((li) => (li.onclick = () => vscode.postMessage({ type: 'expand', id: n.id, dir: li.dataset.expand })));
}

// ── pan & zoom ─────────────────────────────────────────────────────────────
const viewport = $('viewport');
let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | undefined;
viewport.addEventListener('mousedown', (e) => {
  if ((e.target as HTMLElement).closest('.node')) return;
  drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
  viewport.classList.add('panning');
});
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  view.x = drag.vx + e.clientX - drag.x;
  view.y = drag.vy + e.clientY - drag.y;
  drag.moved ||= Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3;
  applyView();
});
window.addEventListener('mouseup', () => {
  if (drag && !drag.moved) select(undefined, false);
  drag = undefined;
  viewport.classList.remove('panning');
});
viewport.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const r = viewport.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
    } else {
      view.x -= e.deltaX;
      view.y -= e.deltaY;
      applyView();
    }
  },
  { passive: false },
);

function applyView() {
  $('world').style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
}
function zoomAt(factor: number, cx: number, cy: number) {
  const k = Math.min(2.5, Math.max(0.15, view.k * factor));
  view.x = cx - ((cx - view.x) * k) / view.k;
  view.y = cy - ((cy - view.y) * k) / view.k;
  view.k = k;
  applyView();
}
function zoomBy(f: number) {
  zoomAt(f, viewport.clientWidth / 2, viewport.clientHeight / 2);
}
function fit() {
  const all = [...positions.values()];
  if (!all.length) return;
  const x1 = Math.min(...all.map((p) => p.x)) - 40;
  const y1 = Math.min(...all.map((p) => p.y)) - 60;
  const x2 = Math.max(...all.map((p) => p.x + p.w)) + 40;
  const y2 = Math.max(...all.map((p) => p.y + p.h)) + 40;
  const k = Math.min(1.1, Math.max(0.15, Math.min(viewport.clientWidth / (x2 - x1), viewport.clientHeight / (y2 - y1))));
  view = { k, x: (viewport.clientWidth - (x2 - x1) * k) / 2 - x1 * k, y: (viewport.clientHeight - (y2 - y1) * k) / 2 - y1 * k };
  applyView();
}
function centerOn(id: string) {
  const p = positions.get(id);
  if (!p) return;
  view.k = Math.max(view.k, 0.8);
  view.x = viewport.clientWidth / 2 - (p.x + p.w / 2) * view.k;
  view.y = viewport.clientHeight / 2 - (p.y + p.h / 2) * view.k;
  applyView();
}

// ── misc ───────────────────────────────────────────────────────────────────
function updateStats() {
  const target = byId.get(trace.targetId);
  const up = trace.nodes.filter((n) => n.role === 'up').length;
  const down = trace.nodes.filter((n) => n.role === 'down').length;
  const apps = new Set(trace.nodes.map((n) => n.app)).size;
  const http = trace.edges.some((e) => e.kind === 'http');
  const tests = trace.nodes.filter((n) => n.layer === 'test').length;
  $('title').textContent = target ? nameOf(target) : 'Trace';
  const warn = trace.warnings.length ? `⚠ ${trace.warnings.length} lookup${trace.warnings.length === 1 ? '' : 's'} failed` : '';
  $('stats').title = trace.warnings.join('\n');
  $('stats').textContent = [warn, `${up} upstream`, `${down} downstream`, apps > 1 ? `${apps} apps` : '', http ? 'crosses HTTP' : '', tests ? `${tests} test${tests === 1 ? '' : 's'}` : '']
    .filter(Boolean)
    .join(' · ');
}
function nameOf(n: TraceNode) {
  return n.container && n.layer !== 'api' ? `${n.container}.${n.name}` : n.name;
}
function showOverlay(html: string) {
  $('overlay').style.display = 'grid';
  $('overlay').innerHTML = `<div class="box">${html}</div>`;
}
function hideOverlay() {
  $('overlay').style.display = 'none';
}
function basename(p: string) {
  return p.split('/').pop() ?? p;
}
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

applyView();
vscode.postMessage({ type: 'ready' });
