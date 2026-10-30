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
 * on each side: a "}" or a blank line is found again by its neighbours, not at any "}".
 */
function anchorOf(lines, start, end) {
  return {
    anchor: lines.slice(start, Math.min(end, start + MAX_ANCHOR - 1) + 1).map((l) => l.slice(0, MAX_LINE)),
    before: start > 0 ? lines[start - 1].slice(0, MAX_LINE) : null,
    after: end + 1 < lines.length ? lines[end + 1].slice(0, MAX_LINE) : null,
  };
}

/**
 * Where a comment's lines are now: the place nearest to where they were (`start`) where they
 * still are, preferring one whose neighbours are the same too, and looking below first (lines
 * added above move them down); undefined when they are not there any more.
 * @param {string[]} normed the file's lines, normalized once (see normLines)
 * @param {{anchor: string[], before?: string|null, after?: string|null}} where
 */
function relocate(normed, start, where) {
  const anchor = where.anchor.map(norm);
  if (!anchor.length || !anchor.some(Boolean)) {
    // Blank lines only: found by their neighbours alone, else where they were.
    if (where.before == null && where.after == null) return start < normed.length ? start : undefined;
  }
  const n = anchor.length;
  const at = (i) => {
    for (let k = 0; k < n; k++) if (normed[i + k] !== anchor[k]) return false;
    return true;
  };
  const context = (i) => (where.before == null || normed[i - 1] === norm(where.before)) && (where.after == null || normed[i + n] === norm(where.after));
  let loose;
  const last = normed.length - n;
  for (let d = 0; d <= Math.max(start, last - start); d++) {
    for (const i of d ? [start + d, start - d] : [start]) {
      if (i < 0 || i > last || !at(i)) continue;
      if (context(i)) return i;
      if (loose === undefined) loose = i;
    }
  }
  // Blank lines whose neighbours changed too: no telling where they went.
  return anchor.some(Boolean) ? loose : undefined;
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
