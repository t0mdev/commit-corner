'use strict';

/**
 * Review comments for an agent, without VS Code: where a comment's lines are now (the file may
 * have changed since), and the review as text to paste into the agent's chat or to save in its
 * worktree.
 */

/** At most this many lines of code under a comment (in the store and in the review). */
const MAX_ANCHOR = 20;
/** A line longer than this is cut (a minified file must not put megabytes into a prompt). */
const MAX_LINE = 500;

/** The lines of a text, whatever its line endings. */
const splitLines = (text) => String(text).split(/\r\n|\r|\n/);

/** A line as it is compared: without its indentation (a reformat keeps a comment), cut. */
const norm = (s) => String(s).slice(0, MAX_LINE).trim();

/**
 * The lines a comment covers, as stored to find them again (capped), with one line of context
 * on each side: a "}" or a blank line is found again by its neighbours, not at any "}". (A
 * thread longer than the stored lines keeps no line after: it would not be next to them.)
 */
function anchorOf(lines, start, end) {
  const last = Math.min(end, start + MAX_ANCHOR - 1);
  const at = (i) => (i >= 0 && i < lines.length ? String(lines[i]).slice(0, MAX_LINE) : null);
  return {
    anchor: lines.slice(start, last + 1).map((l) => String(l).slice(0, MAX_LINE)),
    before: at(start - 1),
    after: last === end ? at(end + 1) : null,
  };
}

/** Lines worth finding anywhere in a file: with some letters or digits (not just "}" or "end"). */
const distinctive = (anchor) => anchor.some((l) => (norm(l).match(/[A-Za-z0-9_]/g) || []).length >= 4);

/**
 * Where a comment's lines are now, or undefined when they are gone:
 *  1. where they were, when they still are there with a neighbour as it was;
 *  2. else the nearest place (below first: lines added above move them down) where they are
 *     with both neighbours as they were, then with one (a lone "}": only a line or two away);
 *  3. else where they were, when they still are there (both neighbours edited);
 *  4. else the nearest place they are at all, if they are distinctive (a lone "}" is not).
 * @param {string[]} normed the file's lines, normalized once (see normLines)
 * @param {{anchor: string[], before?: string|null, after?: string|null}} where
 * @param {number} [radius] look no further than this from `start` (an edit's surroundings)
 */
function relocate(normed, start, where, radius = Infinity) {
  const anchor = where.anchor.map(norm);
  const n = anchor.length;
  const before = where.before == null ? null : norm(where.before);
  const after = where.after == null ? null : norm(where.after);
  if (!n) return start < normed.length ? start : undefined;
  const at = (i) => {
    if (i < 0 || i + n > normed.length) return false;
    for (let k = 0; k < n; k++) if (normed[i + k] !== anchor[k]) return false;
    return true;
  };
  // How many of its neighbours are as they were (a missing one counts as matching).
  const near = (i) => (before === null || normed[i - 1] === before ? 1 : 0) + (after === null || normed[i + n] === after ? 1 : 0);
  if (at(start) && near(start) >= 1) return start;
  const far = Math.min(radius, Math.max(start, normed.length - start));
  // A "}" with one neighbour as it was is only itself close by; distinctive lines anywhere.
  const sure = distinctive(where.anchor);
  let one;
  let loose;
  for (let d = 1; d <= far; d++) {
    for (const i of [start + d, start - d]) {
      if (!at(i)) continue;
      const k = near(i);
      if (k === 2) return i;
      if (k === 1 && one === undefined && (sure || d <= 2)) one = i;
      if (loose === undefined) loose = i;
    }
  }
  if (one !== undefined) return one;
  if (at(start)) return start;
  return loose !== undefined && sure ? loose : undefined;
}

/** A file's lines as relocate compares them (once per file, however many comments it has). */
const normLines = (lines) => lines.map(norm);

/** A Markdown code fence longer than any run of backticks in the text it holds. */
function fence(text) {
  const runs = String(text).match(/`+/g) || [];
  return '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
}

/** Text from the repository (a path, a folder's name) on one line: control characters shown as escapes. */
const oneLine = (text) => String(text).replace(/[\u0000-\u001f\u007f]/g, (c) => (c === '\t' ? '\\t' : c === '\n' ? '\\n' : c === '\r' ? '\\r' : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));

/** A code span for a name (a path with backticks or line breaks in it still reads as one). */
function codeSpan(text) {
  const t = oneLine(text);
  const runs = t.match(/`+/g) || [];
  const tick = '`'.repeat(Math.max(1, ...runs.map((r) => r.length + 1)));
  const pad = /^`|`$/.test(t) ? ' ' : '';
  return `${tick}${pad}${t}${pad}${tick}`;
}

/** The fence's language: the file's extension when it is a plain one ("js", "py"). */
function language(file) {
  const m = /\.([A-Za-z0-9+#-]{1,10})$/.exec(file);
  return m ? m[1].toLowerCase() : '';
}

/** A comment as a block quote: whatever it holds (an open ``` fence, a "#" line) stays inside it. */
const quote = (text) => String(text).split(/\r\n|\r|\n/).map((l) => (l ? `> ${l}` : '>')).join('\n');

/**
 * The review as Markdown for the agent: what to do, then each comment with its file, lines and
 * code, by file and line. `state`: "current" (the code as it is now), "changed" (the lines are
 * not there any more: the code as it was), "missing" (the file is gone).
 * @param {{name: string, branch?: string, threads: {path: string, ref?: string|null, start: number, end: number, state?: 'current'|'changed'|'missing', code: string[], comments: string[]}[]}} review
 */
function reviewText(review) {
  const threads = review.threads.slice().sort((a, b) => a.path.localeCompare(b.path, 'en') || a.start - b.start);
  const where = review.branch ? `branch ${codeSpan(review.branch)} (${oneLine(review.name)})` : oneLine(review.name);
  const out = [
    `# Review comments for ${where}`,
    '',
    `Please address ${threads.length === 1 ? 'this review comment' : `these ${threads.length} review comments`}. Line numbers are those of the files as they are now, unless a commit is named.`,
  ];
  threads.forEach((t, k) => {
    const state = t.state || 'current';
    const lines = t.start === t.end ? `line ${t.start + 1}` : `lines ${t.start + 1}–${t.end + 1}`;
    const inCommit = t.ref ? ` in commit ${t.ref.slice(0, 7)}` : '';
    const note = state === 'changed' ? ' (these lines have changed since the comment; they were:)' : state === 'missing' ? ' (the file is not there any more; the lines were:)' : '';
    out.push('', `## ${k + 1}. ${codeSpan(t.path)}, ${lines}${inCommit}${note}`, '');
    if (t.code && t.code.length) {
      const cut = t.code.map((l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}…` : l));
      // Line numbers only for the code as it is now (old code at today's numbers would mislead).
      const width = String(t.start + cut.length).length;
      const body = state === 'current' ? cut.map((l, i) => `${String(t.start + 1 + i).padStart(width)}  ${l}`).join('\n') : cut.join('\n');
      const f = fence(body);
      out.push(`${f}${language(t.path)}`, body, f, '');
    }
    out.push(t.comments.map(quote).join('\n\n'));
  });
  return `${out.join('\n')}\n`;
}

module.exports = { MAX_ANCHOR, MAX_LINE, splitLines, normLines, anchorOf, relocate, reviewText, fence, codeSpan, oneLine };
