import type { FilePatch, Hunk } from './types';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse output of `git diff -U0 -M --full-index --no-color --no-ext-diff`.
 * Paths are expected unquoted (`-c core.quotePath=false`).
 */
export function parsePatch(text: string): FilePatch[] {
  const files: FilePatch[] = [];
  let cur: FilePatch | undefined;
  let hunk: Hunk | undefined;

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (cur) files.push(cur);
      const { a, b } = splitGitHeader(line.slice('diff --git '.length));
      cur = {
        path: b,
        oldPath: a,
        change: 'modified',
        binary: false,
        modeChanged: false,
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      hunk = undefined;
      continue;
    }
    if (!cur) continue;

    if (hunk) {
      const c = line[0];
      if (c === '+' || c === '-' || c === '\\') {
        hunk.lines.push(line);
        if (c === '+') cur.additions++;
        if (c === '-') cur.deletions++;
        continue;
      }
      if (c === ' ') {
        hunk.lines.push(line);
        continue;
      }
      hunk = undefined;
    }

    const m = HUNK_RE.exec(line);
    if (m) {
      hunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      cur.hunks.push(hunk);
    } else if (line.startsWith('new file mode')) {
      cur.change = 'added';
    } else if (line.startsWith('deleted file mode')) {
      cur.change = 'deleted';
    } else if (line.startsWith('rename from ')) {
      cur.change = 'renamed';
      cur.oldPath = line.slice('rename from '.length);
    } else if (line.startsWith('rename to ')) {
      cur.path = line.slice('rename to '.length);
    } else if (line.startsWith('old mode') || line.startsWith('new mode')) {
      cur.modeChanged = true;
    } else if (line.startsWith('index ')) {
      const [shas] = line.slice('index '.length).split(' ');
      const [oldBlob, newBlob] = shas.split('..');
      cur.oldBlob = isNullSha(oldBlob) ? undefined : oldBlob;
      cur.newBlob = isNullSha(newBlob) ? undefined : newBlob;
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      cur.binary = true;
    } else if (line.startsWith('--- ') && line !== '--- /dev/null') {
      cur.oldPath = stripPrefix(line.slice(4), 'a/');
    } else if (line.startsWith('+++ ') && line !== '+++ /dev/null') {
      cur.path = stripPrefix(line.slice(4), 'b/');
    }
  }
  if (cur) files.push(cur);

  for (const f of files) {
    if (f.change === 'added') f.oldPath = f.path;
    if (f.change === 'deleted') f.path = f.oldPath;
  }
  return files;
}

/** Parse `git diff --numstat -z` into path → total changed lines. */
export function parseNumstatZ(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const parts = text.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const [add, del, path] = p.split('\t');
    const n = add === '-' ? Number.NaN : Number(add) + Number(del);
    if (path) {
      out.set(path, n);
    } else {
      // Rename: "add\tdel\t\0old\0new\0"
      const newPath = parts[i + 2];
      i += 2;
      if (newPath) out.set(newPath, n);
    }
  }
  return out;
}

function splitGitHeader(rest: string): { a: string; b: string } {
  // "a/<path> b/<path>". Paths may contain spaces; when not renamed both halves are equal.
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === ' ') {
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (a.slice(2) === b.slice(2)) return { a: a.slice(2), b: b.slice(2) };
  }
  const idx = rest.indexOf(' b/');
  return { a: stripPrefix(rest.slice(0, idx), 'a/'), b: stripPrefix(rest.slice(idx + 1), 'b/') };
}

function stripPrefix(s: string, prefix: string): string {
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

function isNullSha(s: string | undefined): boolean {
  return !s || /^0+$/.test(s);
}
