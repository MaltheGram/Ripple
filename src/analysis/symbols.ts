import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ChangedFile } from '../core/types';
import type { ReviewSession } from '../ui/session';

export interface ChangedSymbol {
  id: string;
  name: string;
  /** e.g. the class of a method. */
  container?: string;
  kind: vscode.SymbolKind;
  change: 'added' | 'modified';
  file: ChangedFile;
  uri: vscode.Uri;
  range: vscode.Range;
  selection: vscode.Range;
}

const CALLABLE = new Set([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
]);
/** Only counted when multi-line, e.g. `const handler = () => { … }` or a class property arrow function. */
const MAYBE_CALLABLE = new Set([vscode.SymbolKind.Variable, vscode.SymbolKind.Constant, vscode.SymbolKind.Property, vscode.SymbolKind.Field]);
const CONTAINER = new Set([vscode.SymbolKind.Class, vscode.SymbolKind.Interface, vscode.SymbolKind.Enum, vscode.SymbolKind.Struct, vscode.SymbolKind.Module, vscode.SymbolKind.Namespace]);

export function symbolId(uri: vscode.Uri, pos: vscode.Position): string {
  return `${uri.fsPath}:${pos.line}:${pos.character}`;
}

/**
 * Functions/methods (or, failing that, classes) in the new version of `file` that contain changed lines.
 * Uses the language server's document symbols, so it works for any language with symbol support.
 */
export async function changedSymbols(s: ReviewSession, file: ChangedFile): Promise<ChangedSymbol[]> {
  if (file.change === 'deleted' || file.binary) return [];
  const uri = vscode.Uri.file(path.join(s.entry.worktree, file.path));
  const roots = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
    'vscode.executeDocumentSymbolProvider',
    uri,
  );
  if (!roots?.length || !('children' in roots[0])) return [];

  const changed = changedNewLines(file);
  const touches = (r: vscode.Range) => changed.lines.some((l) => l >= r.start.line && l <= r.end.line);
  const allAdded = (r: vscode.Range) => {
    for (let l = r.start.line; l <= r.end.line; l++) if (!changed.added.has(l)) return false;
    return true;
  };

  const out = new Map<string, ChangedSymbol>();
  const visit = (sym: vscode.DocumentSymbol, container?: string) => {
    if (!touches(sym.range)) return;
    const before = out.size;
    const inner = CONTAINER.has(sym.kind) ? sym.name : container;
    for (const child of sym.children) visit(child, inner);

    const callable = CALLABLE.has(sym.kind) || (MAYBE_CALLABLE.has(sym.kind) && sym.range.end.line > sym.range.start.line);
    // A class counts only when the change isn't inside one of its members.
    const fallback = CONTAINER.has(sym.kind) && out.size === before;
    if ((callable && out.size === before) || fallback) {
      const id = symbolId(uri, sym.selectionRange.start);
      out.set(id, {
        id,
        name: sym.name,
        container,
        kind: sym.kind,
        change: file.change === 'added' || allAdded(sym.range) ? 'added' : 'modified',
        file,
        uri,
        range: sym.range,
        selection: sym.selectionRange,
      });
    }
  };
  for (const r of roots as vscode.DocumentSymbol[]) visit(r);
  return [...out.values()];
}

/** 0-based new-file lines that are added, plus the line where a pure deletion happened. */
function changedNewLines(file: ChangedFile): { lines: number[]; added: Set<number> } {
  const lines: number[] = [];
  const added = new Set<number>();
  for (const h of file.hunks) {
    if (h.newLines === 0) {
      lines.push(Math.max(0, h.newStart - 1));
      continue;
    }
    for (let l = h.newStart; l < h.newStart + h.newLines; l++) {
      lines.push(l - 1);
      added.add(l - 1);
    }
  }
  return { lines, added };
}

export function symbolLabel(sym: { name: string; container?: string }): string {
  return sym.container ? `${sym.container}.${sym.name}` : sym.name;
}
