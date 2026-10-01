// Visual checks for the trace webview: renders fixture traces in headless Chrome (system Chrome via playwright-core),
// asserts layout invariants (robust across machines), and compares screenshots with per-OS baselines.
//
//   npm run test:visual            check against baselines (creates missing ones)
//   npm run test:visual -- --update  rewrite baselines
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const here = path.join(root, 'test/visual');
const out = path.join(here, 'output');
const baselines = path.join(here, 'baseline', process.platform);
const update = process.argv.includes('--update');
const MAX_DIFF = 0.015; // share of pixels allowed to differ (antialiasing, font hinting)

mkdirSync(out, { recursive: true });
mkdirSync(baselines, { recursive: true });
copyFileSync(path.join(root, 'dist/webview/trace.js'), path.join(out, 'trace.js'));
const template = readFileSync(path.join(root, 'src/webview/trace.html'), 'utf8');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 1 });
let failures = 0;

for (const file of readdirSync(path.join(here, 'fixtures')).filter((f) => f.endsWith('.json'))) {
  const name = file.replace(/\.json$/, '');
  const trace = readFileSync(path.join(here, 'fixtures', file), 'utf8');
  const mock = `<script nonce="t">window.acquireVsCodeApi = () => ({ postMessage(m) { if (m.type === 'ready') setTimeout(() => window.postMessage({ type: 'trace', trace: ${trace}, viewedFiles: [] }), 0); }, getState() {}, setState() {} });</script>`;
  const html = template
    .replace('{{CSP}}', "default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-t' file:")
    .replace('<script nonce="{{NONCE}}" src="{{SCRIPT}}"></script>', `${mock}<script nonce="t" src="trace.js"></script>`);
  const htmlPath = path.join(out, `${name}.html`);
  writeFileSync(htmlPath, html);

  await page.goto(`file://${htmlPath}`);
  await page.waitForSelector('body[data-layout]', { timeout: 10_000 });
  await page.waitForTimeout(150);

  // ── layout invariants ──
  const problems = await page.evaluate(() => {
    const issues = [];
    const rect = (el) => {
      const s = el.style;
      return { x: parseFloat(s.left), y: parseFloat(s.top), w: el.offsetWidth, h: el.offsetHeight };
    };
    const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const nodes = [...document.querySelectorAll('.node')].map((el) => ({ el, id: el.dataset.id, app: el.dataset.app, r: rect(el) }));
    const boxes = [...document.querySelectorAll('.app')].map((el) => ({ app: el.dataset.app, r: rect(el) }));
    if (!nodes.length) issues.push('no nodes rendered');
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) if (overlap(nodes[i].r, nodes[j].r)) issues.push(`cards overlap: ${nodes[i].id} / ${nodes[j].id}`);
    for (const n of nodes) {
      const box = boxes.find((b) => b.app === n.app);
      const inside = box && n.r.x >= box.r.x && n.r.y >= box.r.y && n.r.x + n.r.w <= box.r.x + box.r.w && n.r.y + n.r.h <= box.r.y + box.r.h;
      if (!inside) issues.push(`card ${n.id} is outside its app box ${n.app}`);
    }
    const byId = new Map(nodes.map((n) => [n.id, n.r]));
    const near = (p, r, tol = 14) => p.x >= r.x - tol && p.x <= r.x + r.w + tol && p.y >= r.y - tol && p.y <= r.y + r.h + tol;
    for (const p of document.querySelectorAll('.edge')) {
      const len = p.getTotalLength();
      const a = p.getPointAtLength(0);
      const b = p.getPointAtLength(len);
      const from = byId.get(p.dataset.from);
      const to = byId.get(p.dataset.to);
      if (!from || !to) continue;
      if (!near(a, from) || !near(b, to)) issues.push(`edge ${p.dataset.from} → ${p.dataset.to} is not attached to its cards`);
    }
    for (const l of document.querySelectorAll('.edge-label')) {
      const r = l.getBoundingClientRect();
      for (const n of nodes) {
        const c = n.el.getBoundingClientRect();
        if (r.left < c.right && c.left < r.right && r.top < c.bottom && c.top < r.bottom) issues.push(`edge label "${l.textContent}" covers card ${n.id}`);
      }
    }
    const overlay = document.getElementById('overlay');
    if (overlay && getComputedStyle(overlay).display !== 'none') issues.push(`overlay shown: ${overlay.textContent.trim()}`);
    return issues;
  });

  // ── screenshot vs baseline ──
  const shot = path.join(out, `${name}.png`);
  await page.screenshot({ path: shot });
  const base = path.join(baselines, `${name}.png`);
  let pixelNote = '';
  if (update || !existsSync(base)) {
    copyFileSync(shot, base);
    pixelNote = update ? 'baseline updated' : 'baseline created';
  } else {
    const a = PNG.sync.read(readFileSync(shot));
    const b = PNG.sync.read(readFileSync(base));
    if (a.width !== b.width || a.height !== b.height) problems.push('screenshot size differs from baseline');
    else {
      const diff = new PNG({ width: a.width, height: a.height });
      const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.15 });
      const share = n / (a.width * a.height);
      pixelNote = `${(share * 100).toFixed(2)}% pixels differ`;
      if (share > MAX_DIFF) {
        writeFileSync(path.join(out, `${name}.diff.png`), PNG.sync.write(diff));
        problems.push(`looks different from baseline (${pixelNote}); see test/visual/output/${name}.diff.png`);
      }
    }
  }

  if (problems.length) {
    failures++;
    console.log(`✗ ${name}\n${problems.map((p) => `    - ${p}`).join('\n')}`);
  } else console.log(`✓ ${name} (${pixelNote})`);
}

await browser.close();
if (failures) {
  console.log(`\n${failures} visual check(s) failed. If the change is intended: npm run test:visual -- --update`);
  process.exit(1);
}
