import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ChangedFile } from '../core/types';
import type { ReviewSession } from '../ui/session';
import { changedSymbols, type ChangedSymbol } from './symbols';

const CONCURRENCY = 6;

export interface Caller {
  label: string;
  uri: vscode.Uri;
  range: vscode.Range;
  /** The caller is itself changed in this MR. */
  inMr: boolean;
}

/** For each changed symbol in `file`: who calls it. Falls back to references when there's no call hierarchy. */
export async function impactOf(s: ReviewSession, file: ChangedFile): Promise<{ symbol: ChangedSymbol; callers: Caller[] }[]> {
  const syms = await changedSymbols(s, file);
  const changedFiles = new Set(s.files.map((f) => f.path));
  const rel = (uri: vscode.Uri) => path.relative(s.entry.worktree, uri.fsPath).split(path.sep).join('/');

  return pool(syms, CONCURRENCY, async (symbol) => {
    const item = await prepare(symbol);
    let callers: Caller[] = [];
    if (item) {
      const inc = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', item);
      callers = (inc ?? []).map((c) => ({ label: itemLabel(c.from), uri: c.from.uri, range: c.fromRanges[0] ?? c.from.selectionRange, inMr: false }));
    }
    if (!callers.length) {
      const refs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', symbol.uri, symbol.selection.start);
      callers = (refs ?? [])
        .filter((r) => !(r.uri.fsPath === symbol.uri.fsPath && symbol.range.contains(r.range)))
        .map((r) => ({ label: `${rel(r.uri)}:${r.range.start.line + 1}`, uri: r.uri, range: r.range, inMr: false }));
    }
    for (const c of callers) c.inMr = changedFiles.has(rel(c.uri));
    return { symbol, callers };
  });
}

async function prepare(sym: ChangedSymbol): Promise<vscode.CallHierarchyItem | undefined> {
  const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', sym.uri, sym.selection.start);
  return items?.[0];
}

function itemLabel(item: vscode.CallHierarchyItem): string {
  if (item.kind === vscode.SymbolKind.File || item.kind === vscode.SymbolKind.Module) return `${item.name} (top level)`;
  // TS puts the class in `detail` for methods ("OrderService"); keep it short.
  const detail = item.detail && !item.detail.includes('/') && !item.detail.includes(' ') ? item.detail : undefined;
  return detail ? `${detail}.${item.name}` : item.name;
}

/** Map with bounded concurrency, stopping early on cancel. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>, cancel?: vscode.CancellationToken): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !cancel?.isCancellationRequested) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out.filter((x) => x !== undefined);
}
