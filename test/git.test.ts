import { mkdtemp, rm, writeFile, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classify } from '../src/core/classify';
import { positionForNewLine } from '../src/core/lineMap';
import { parseNumstatZ, parsePatch } from '../src/core/patch';
import { git } from '../src/repo/git';
import { readWorktreeFileSync } from '../src/repo/safeRead';
import { symlinkSync } from 'node:fs';

let dir: string;
let base: string;
let head: string;

const run = (...args: string[]) => git(args, { cwd: dir });
const write = async (p: string, content: string) => {
  await mkdir(path.dirname(path.join(dir, p)), { recursive: true });
  await writeFile(path.join(dir, p), content);
};
const commit = async (msg: string) => {
  await run('add', '-A');
  await run('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg);
  return (await run('rev-parse', 'HEAD')).trim();
};

const serviceV1 = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'br-git-'));
  await run('init', '-q');
  await write('src/order/order.service.ts', serviceV1);
  await write('src/format.ts', 'const a = 1;\nconst b = 2;\n');
  await write('src/imports.ts', "import { A } from './a';\nexport const x = A;\n");
  await write('src/old name.ts', 'export const moved = true;\n'.repeat(5));
  await write('src/gone.ts', 'bye\n');
  await write('package-lock.json', '{}\n');
  base = await commit('base');

  const lines = serviceV1.split('\n');
  lines.splice(3, 0, 'inserted A', 'inserted B'); // after old line 3
  lines[11] = 'changed old line 10';
  await write('src/order/order.service.ts', lines.join('\n'));
  await write('src/format.ts', 'const a  = 1;\n  const b = 2;\n');
  await write('src/imports.ts', "import { A, B } from './a';\nexport const x = A;\n");
  await rename(path.join(dir, 'src/old name.ts'), path.join(dir, 'src/new name.ts'));
  await rm(path.join(dir, 'src/gone.ts'));
  await write('src/order/dto/create-order.dto.ts', 'export class CreateOrderDto {}\n');
  await write('package-lock.json', '{"v":2}\n');
  head = await commit('head');
});

afterAll(() => rm(dir, { recursive: true, force: true }));

describe('real git output', () => {
  it('parses and classifies an MR-like diff', async () => {
    const [patch, ws] = await Promise.all([
      run('diff', '-U0', '-M', '--full-index', '--no-color', '--no-ext-diff', base, head),
      run('diff', '-w', '-M', '--numstat', '-z', '--no-ext-diff', base, head),
    ]);
    const files = classify({
      patches: parsePatch(patch),
      whitespaceIgnored: parseNumstatZ(ws),
      trivialGlobs: ['**/package-lock.json'],
    });
    const by = Object.fromEntries(files.map((f) => [f.path, f]));

    expect(Object.keys(by).sort()).toEqual([
      'package-lock.json',
      'src/format.ts',
      'src/gone.ts',
      'src/imports.ts',
      'src/new name.ts',
      'src/order/dto/create-order.dto.ts',
      'src/order/order.service.ts',
    ]);
    expect(by['src/new name.ts']).toMatchObject({ change: 'renamed', oldPath: 'src/old name.ts', trivial: 'rename-only' });
    expect(by['src/gone.ts'].change).toBe('deleted');
    expect(by['src/order/dto/create-order.dto.ts'].change).toBe('added');
    expect(by['package-lock.json'].trivial).toBe('generated');
    expect(by['src/format.ts'].trivial).toBe('whitespace-only');
    expect(by['src/imports.ts'].trivial).toBe('import-only');

    const svc = by['src/order/order.service.ts'];
    expect(svc.trivial).toBeUndefined();
    expect(svc.newBlob).toMatch(/^[0-9a-f]{40}$/);
    expect(positionForNewLine(svc.hunks, 4)).toEqual({ new_line: 4 });
    expect(positionForNewLine(svc.hunks, 6)).toEqual({ old_line: 4, new_line: 6 });
    expect(positionForNewLine(svc.hunks, 12)).toEqual({ new_line: 12 });
    expect(positionForNewLine(svc.hunks, 20)).toEqual({ old_line: 18, new_line: 20 });
  });
});

describe('untrusted checkout reads', () => {
  it('refuses symlinks and paths outside the checkout', async () => {
    const secret = path.join(dir, '..', `secret-${Date.now()}.txt`);
    await writeFile(secret, 'AKIA-not-for-claude');
    symlinkSync(secret, path.join(dir, 'src/link.ts'));
    expect(readWorktreeFileSync(dir, 'src/link.ts')).toBeUndefined();
    expect(readWorktreeFileSync(dir, '../' + path.basename(secret))).toBeUndefined();
    expect(readWorktreeFileSync(dir, 'src/format.ts')).toContain('const a');
    await rm(secret);
  });
});
