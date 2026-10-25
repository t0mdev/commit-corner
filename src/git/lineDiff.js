'use strict';

/**
 * Line-level diffing and selective application of changes. This powers
 * "stage / unstage / discard selected lines" without shelling out to
 * `git apply`, so it also works on unsaved editor content.
 *
 * A change is {origStart, origEnd, modStart, modEnd}: 0-based, end-exclusive
 * line ranges in the original and modified texts.
 */

/** Split text into lines that keep their terminators, so joining is lossless. */
function splitLines(text) {
  if (!text) return [];
  const out = text.match(/[^\n]*\n|[^\n]+$/g);
  return out || [];
}

/**
 * Upper bound on inner-loop steps (well under a second of work). Beyond it the
 * diff is refused rather than approximated: line staging must never guess.
 */
const WORK_BUDGET = 5e7;

class DiffTooLargeError extends Error {
  constructor() {
    super('The file has too many differences for line-level staging. Stage the whole file instead.');
    this.name = 'DiffTooLargeError';
  }
}

/**
 * Minimal line diff (Myers' O(ND) algorithm in its linear-space,
 * divide-and-conquer form, so memory stays O(N+M) for any edit distance).
 * @param {string[]} a original lines
 * @param {string[]} b modified lines
 * @returns {{origStart:number, origEnd:number, modStart:number, modEnd:number}[]}
 * @throws {DiffTooLargeError}
 */
function diffLines(a, b) {
  const ops = [];
  const budget = { left: WORK_BUDGET };
  diffRange(a, 0, a.length, b, 0, b.length, ops, budget);
  // ops: 'e' (equal), 'd' (delete), 'i' (insert) in order. Fold into changes.
  const changes = [];
  let i = 0;
  let j = 0;
  let cur = null;
  for (const op of ops) {
    if (op === 'e') {
      if (cur) {
        changes.push(cur);
        cur = null;
      }
      i++;
      j++;
      continue;
    }
    if (!cur) cur = { origStart: i, origEnd: i, modStart: j, modEnd: j };
    if (op === 'd') cur.origEnd = ++i;
    else cur.modEnd = ++j;
  }
  if (cur) changes.push(cur);
  return changes;
}

function diffRange(a, aLo, aHi, b, bLo, bHi, ops, budget) {
  // Common prefix and suffix.
  let pre = 0;
  while (aLo + pre < aHi && bLo + pre < bHi && a[aLo + pre] === b[bLo + pre]) pre++;
  let suf = 0;
  while (aHi - suf > aLo + pre && bHi - suf > bLo + pre && a[aHi - 1 - suf] === b[bHi - 1 - suf]) suf++;
  for (let k = 0; k < pre; k++) ops.push('e');
  aLo += pre;
  bLo += pre;
  aHi -= suf;
  bHi -= suf;
  if (aLo === aHi) for (let k = bLo; k < bHi; k++) ops.push('i');
  else if (bLo === bHi) for (let k = aLo; k < aHi; k++) ops.push('d');
  else {
    const [x, y, u, v] = middleSnake(a, aLo, aHi, b, bLo, bHi, budget);
    diffRange(a, aLo, aLo + x, b, bLo, bLo + y, ops, budget);
    for (let k = x; k < u; k++) ops.push('e');
    diffRange(a, aLo + u, aHi, b, bLo + v, bHi, ops, budget);
  }
  for (let k = 0; k < suf; k++) ops.push('e');
}

/**
 * Find the middle snake of the shortest edit script between
 * a[aLo..aHi) and b[bLo..bHi). Returns [x, y, u, v] relative to aLo/bLo:
 * the snake runs diagonally from (x, y) to (u, v).
 */
function middleSnake(a, aLo, aHi, b, bLo, bHi, budget) {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const delta = n - m;
  const odd = (delta & 1) !== 0;
  const max = Math.ceil((n + m) / 2);
  const off = max + 1;
  const vf = new Int32Array(2 * max + 3);
  const vb = new Int32Array(2 * max + 3);
  for (let d = 0; d <= max; d++) {
    budget.left -= 2 * d + 2;
    if (budget.left < 0) throw new DiffTooLargeError();
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && vf[off + k - 1] < vf[off + k + 1]) ? vf[off + k + 1] : vf[off + k - 1] + 1;
      let y = x - k;
      const x0 = x;
      const y0 = y;
      while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
        x++;
        y++;
      }
      vf[off + k] = x;
      const kb = delta - k;
      if (odd && kb >= -(d - 1) && kb <= d - 1 && x + vb[off + kb] >= n) return [x0, y0, x, y];
    }
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && vb[off + k - 1] < vb[off + k + 1]) ? vb[off + k + 1] : vb[off + k - 1] + 1;
      let y = x - k;
      const x0 = x;
      const y0 = y;
      while (x < n && y < m && a[aHi - 1 - x] === b[bHi - 1 - y]) {
        x++;
        y++;
      }
      vb[off + k] = x;
      const kf = delta - k;
      if (!odd && kf >= -d && kf <= d && x + vf[off + kf] >= n) return [n - x, m - y, n - x0, m - y0];
    }
  }
  throw new Error('middleSnake: no path found'); // unreachable for valid input
}

/**
 * Build a text from `from`, taking for every changed line pair either the
 * `from` side or the `to` side depending on `pick`.
 *
 * Inside a change the removed lines R and added lines A are paired by index
 * (R[k] <-> A[k]); surplus lines on either side are unpaired. This gives
 * intuitive line-granular behaviour: selecting one edited line stages exactly
 * that edit.
 *
 * @param {string[]} from
 * @param {string[]} to
 * @param {ReturnType<typeof diffLines>} changes diff(from, to)
 * @param {(change: object, pair: {k:number, fromLine:number|undefined, toLine:number|undefined, anchorTo:number, anchorFrom:number}) => boolean} pickTo
 *        true to take the `to` side for this pair
 * @returns {string[]}
 */
function combine(from, to, changes, pickTo) {
  const out = [];
  let i = 0;
  const fromAt = (idx) => out.push(from[idx]);
  const toAt = (idx) => out.push(to[idx]);
  for (const c of changes) {
    while (i < c.origStart) fromAt(i++);
    const rLen = c.origEnd - c.origStart;
    const aLen = c.modEnd - c.modStart;
    const pairs = Math.max(rLen, aLen);
    for (let k = 0; k < pairs; k++) {
      const fromLine = k < rLen ? c.origStart + k : undefined;
      const toLine = k < aLen ? c.modStart + k : undefined;
      // Where does an unpaired line "live" in the other document? Anchor it to the
      // last paired line, or to the change start for pure insertions/deletions.
      const anchorTo = toLine !== undefined ? toLine : aLen > 0 ? c.modEnd - 1 : c.modStart;
      const anchorFrom = fromLine !== undefined ? fromLine : rLen > 0 ? c.origEnd - 1 : c.origStart;
      if (pickTo(c, { k, fromLine, toLine, anchorTo, anchorFrom })) {
        if (toLine !== undefined) toAt(toLine);
      } else if (fromLine !== undefined) fromAt(fromLine);
    }
    i = c.origEnd;
  }
  while (i < from.length) fromAt(i++);
  return out;
}

/** Marks "no newline at end of file" as a line of its own (cannot occur in text). */
const NO_EOL = '\u0000no-newline-at-end-of-file\u0000';

/**
 * Lines of a text where every line has a terminator; a text that ends without
 * a newline gets one plus a trailing NO_EOL marker line. So "c" and "c\n"
 * compare equal as lines (a line appended after "c" is not glued onto it),
 * while the missing final newline is still a difference of its own.
 */
function terminatedLines(text) {
  const lines = splitLines(text);
  const last = lines.length - 1;
  if (last < 0 || lines[last].endsWith('\n')) return lines;
  lines[last] += eolOf(text);
  lines.push(NO_EOL);
  return lines;
}

/** Join lines produced from terminatedLines(): a NO_EOL marker removes the preceding newline. */
function joinTerminated(lines) {
  const out = [];
  for (const l of lines) {
    if (l === NO_EOL) {
      if (out.length) out[out.length - 1] = out[out.length - 1].replace(/\r?\n$/, '');
    } else out.push(l);
  }
  return out.join('');
}

/** combine() on two texts, with correct handling of a missing final newline. */
function combineTexts(fromText, toText, pickTo) {
  const from = terminatedLines(fromText);
  const to = terminatedLines(toText);
  return joinTerminated(combine(from, to, diffLines(from, to), pickTo));
}

/** Inclusive 0-based line ranges, e.g. from editor selections. */
function inRanges(ranges, line) {
  return ranges.some((r) => line >= r.start && line <= r.end);
}

function changeTouches(ranges, start, end) {
  // end exclusive; pure insert/delete has start === end and is touched at that line or the one before
  if (start === end) return ranges.some((r) => r.end >= start - 1 && r.start <= start);
  return ranges.some((r) => r.start < end && r.end >= start);
}

/**
 * Apply to `from` the parts of diff(from, to) that the selection (expressed in
 * `to` coordinates) covers. Used for staging (from=index, to=worktree).
 * @param {'lines'|'changes'} granularity whole hunks or individual line pairs
 */
function applySelection(fromText, toText, ranges, granularity = 'lines') {
  return combineTexts(fromText, toText, (c, p) =>
    granularity === 'changes' ? changeTouches(ranges, c.modStart, c.modEnd) : selectedInTo(ranges, c, p));
}

/**
 * Revert in `to` the parts of diff(from, to) that the selection (in `to`
 * coordinates) covers. Used for discarding (from=index, to=worktree).
 */
function revertSelection(fromText, toText, ranges, granularity = 'lines') {
  return combineTexts(fromText, toText, (c, p) =>
    !(granularity === 'changes' ? changeTouches(ranges, c.modStart, c.modEnd) : selectedInTo(ranges, c, p)));
}

function selectedInTo(ranges, c, p) {
  if (c.modStart === c.modEnd) return changeTouches(ranges, c.modStart, c.modEnd);
  return inRanges(ranges, p.anchorTo);
}

/**
 * Map a 0-based line in `to` to the corresponding line in `from` given
 * diff(from, to). Lines inside a change map to the paired line or the change
 * boundary.
 */
function mapLineToFrom(changes, line) {
  let delta = 0;
  for (const c of changes) {
    if (line < c.modStart) break;
    if (line < c.modEnd) {
      const k = line - c.modStart;
      return Math.min(c.origStart + k, Math.max(c.origStart, c.origEnd - 1));
    }
    delta = c.origEnd - c.modEnd;
  }
  return line + delta;
}

/** Map inclusive ranges in `to` coordinates into `from` coordinates. */
function mapRangesToFrom(fromText, toText, ranges) {
  const changes = diffLines(terminatedLines(fromText), terminatedLines(toText));
  return ranges.map((r) => ({ start: mapLineToFrom(changes, r.start), end: mapLineToFrom(changes, r.end) }));
}

/** Count changes for display ("3 hunks"). */
function countChanges(fromText, toText) {
  return diffLines(splitLines(fromText), splitLines(toText)).length;
}

/** The line ending a text predominantly uses ('\r\n' or '\n'); `fallback` for texts without line breaks. */
function eolOf(text, fallback = '\n') {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  if (!crlf && !lf) return fallback;
  return crlf > lf ? '\r\n' : '\n';
}

/** Convert every line ending in `text` to `eol`. Line numbers are unchanged. */
function withEol(text, eol) {
  const lf = text.replace(/\r\n/g, '\n');
  return eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf;
}

module.exports = { eolOf, withEol, DiffTooLargeError, splitLines, diffLines, combine, applySelection, revertSelection, mapLineToFrom, mapRangesToFrom, countChanges };
