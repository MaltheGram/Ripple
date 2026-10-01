import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';

// The MR checkout is untrusted: a symlink in it could point at ~/.aws/credentials. Reads of checkout files go
// through these helpers, which refuse symlinks and anything that resolves outside the checkout.

function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function readWorktreeFileSync(worktree: string, rel: string): string | undefined {
  try {
    const p = path.join(worktree, rel);
    if (!inside(worktree, p) || lstatSync(p).isSymbolicLink()) return undefined;
    if (!inside(realpathSync(worktree), realpathSync(p))) return undefined;
    return readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

export async function readWorktreeFile(worktree: string, rel: string): Promise<string | undefined> {
  try {
    const p = path.join(worktree, rel);
    if (!inside(worktree, p) || (await lstat(p)).isSymbolicLink()) return undefined;
    if (!inside(await realpath(worktree), await realpath(p))) return undefined;
    return await readFile(p, 'utf8');
  } catch {
    return undefined;
  }
}
