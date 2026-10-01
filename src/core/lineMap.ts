import { createHash } from 'node:crypto';
import type { Hunk } from './types';

export interface LinePos {
  old_line?: number;
  new_line?: number;
}

/**
 * Map a 1-based line in the new file to a GitLab diff position.
 * Hunks must come from a `-U0` diff so every line outside them is unchanged.
 * Added lines get only `new_line`; unchanged lines get both.
 */
export function positionForNewLine(hunks: Hunk[], line: number): LinePos {
  let delta = 0;
  for (const h of hunks) {
    if (h.newLines > 0 && line >= h.newStart && line < h.newStart + h.newLines) {
      return { new_line: line };
    }
    const before = h.newLines > 0 ? h.newStart + h.newLines - 1 < line : h.newStart < line;
    if (before) delta += h.newLines - h.oldLines;
  }
  return { old_line: line - delta, new_line: line };
}

/** Map a 1-based line in the old file to a GitLab diff position. */
export function positionForOldLine(hunks: Hunk[], line: number): LinePos {
  let delta = 0;
  for (const h of hunks) {
    if (h.oldLines > 0 && line >= h.oldStart && line < h.oldStart + h.oldLines) {
      return { old_line: line };
    }
    const before = h.oldLines > 0 ? h.oldStart + h.oldLines - 1 < line : h.oldStart < line;
    if (before) delta += h.newLines - h.oldLines;
  }
  return { old_line: line, new_line: line + delta };
}

export interface RangePoint {
  line_code: string;
  type?: 'new' | 'old';
  old_line?: number;
  new_line?: number;
}

export interface LineRange {
  start: RangePoint;
  end: RangePoint;
}

/**
 * GitLab `line_range` for a multi-line comment on one side of the diff (1-based, inclusive).
 * Each end carries a `line_code` = sha1(path)_oldPos_newPos, where an added line's oldPos is the next
 * old line and a removed line's newPos is the next new line, matching GitLab's own diff model.
 */
export function lineRangeFor(path: string, hunks: Hunk[], side: 'old' | 'new', startLine: number, endLine: number): LineRange {
  const hash = createHash('sha1').update(path).digest('hex');
  const point = (line: number): RangePoint => {
    const { oldPos, newPos, type } = side === 'new' ? fullNew(hunks, line) : fullOld(hunks, line);
    return {
      line_code: `${hash}_${oldPos}_${newPos}`,
      ...(type ? { type } : {}),
      ...(type !== 'new' ? { old_line: oldPos } : {}),
      ...(type !== 'old' ? { new_line: newPos } : {}),
    };
  };
  return { start: point(startLine), end: point(endLine) };
}

function fullNew(hunks: Hunk[], line: number): { oldPos: number; newPos: number; type?: 'new' } {
  for (const h of hunks) {
    if (h.newLines > 0 && line >= h.newStart && line < h.newStart + h.newLines) {
      return { newPos: line, oldPos: h.oldLines > 0 ? h.oldStart + h.oldLines : h.oldStart + 1, type: 'new' };
    }
  }
  return { newPos: line, oldPos: positionForNewLine(hunks, line).old_line! };
}

function fullOld(hunks: Hunk[], line: number): { oldPos: number; newPos: number; type?: 'old' } {
  for (const h of hunks) {
    if (h.oldLines > 0 && line >= h.oldStart && line < h.oldStart + h.oldLines) {
      return { oldPos: line, newPos: h.newLines > 0 ? h.newStart : h.newStart + 1, type: 'old' };
    }
  }
  return { oldPos: line, newPos: positionForOldLine(hunks, line).new_line! };
}
