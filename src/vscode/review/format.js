'use strict';

/**
 * Review comments for an agent, without VS Code: where a comment's lines are now (the file may
 * have changed since), and the review as text to paste into the agent's chat or to save in its
 * worktree.
 */

/** At most this many lines of code under a comment (in the store and in the review). */
const MAX_ANCHOR = 20;
const MAX_LINE = 500;

/** The lines of a text, whatever its line endings. */
const splitLines = (text) => String(text).split(/\r\n|\r|\n/);

/** What a commented line is compared by: its text without the indentation (a reformat keeps it). */
const norm = (s) => String(s).trim();

/** The lines a comment covers, as stored to find them again (capped). */
function anchorOf(lines, start, end) {
  return lines.slice(start, Math.min(end, start + MAX_ANCHOR - 1) + 1).map((l) => l.slice(0, MAX_LINE));
}

/**
 * Where a comment's lines are in `lines` now: at `start` when they still are there, else the
 * nearest place they are (lines added or removed above them), else undefined (they changed).
 */
function relocate(lines, start, anchor) {
  if (!anchor || !anchor.length || !anchor.some((a) => norm(a))) return start < lines.length ? start : undefined;
  const at = (i) => anchor.every((a, k) => i + k < lines.length && norm(lines[i + k].slice(0, MAX_LINE)) === norm(a));
  if (at(start)) return start;
  let best;
  for (let i = 0; i + anchor.length <= lines.length; i++) {
    if (at(i) && (best === undefined || Math.abs(i - start) < Math.abs(best - start))) best = i;
  }
  return best;
}

/** A Markdown code fence longer than any run of backticks in the text it holds. */
function fence(text) {
  const runs = String(text).match(/`+/g) || [];
  return '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
}

/** A code span for a name (a path with backticks in it still reads as one). */
function codeSpan(text) {
  const runs = String(text).match(/`+/g) || [];
  const tick = '`'.repeat(Math.max(1, ...runs.map((r) => r.length + 1)));
  const pad = /^`|`$/.test(text) ? ' ' : '';
  return `${tick}${pad}${text}${pad}${tick}`;
}

/**
 * The review as Markdown for the agent: what to do, then each comment with the file, the lines
 * and the code they are about, oldest file first.
 * @param {{name: string, branch?: string, threads: {path: string, ref?: string, refLabel?: string, start: number, end: number, outdated?: boolean, code: string[], comments: string[]}[]}} review
 */
function reviewText(review) {
  const threads = review.threads.slice().sort((a, b) => a.path.localeCompare(b.path, 'en') || a.start - b.start);
  const where = review.branch ? `branch ${codeSpan(review.branch)} (${review.name})` : review.name;
  const out = [
    `# Review comments for ${where}`,
    '',
    `Please address ${threads.length === 1 ? 'this review comment' : `these ${threads.length} review comments`}. Line numbers are those of the files as they are now, unless a commit is named.`,
  ];
  threads.forEach((t, k) => {
    const lines = t.start === t.end ? `line ${t.start + 1}` : `lines ${t.start + 1}–${t.end + 1}`;
    const inCommit = t.ref ? ` in commit ${t.refLabel || t.ref.slice(0, 7)}` : '';
    out.push('', `## ${k + 1}. ${codeSpan(t.path)}, ${lines}${inCommit}${t.outdated ? ' (these lines have changed since the comment)' : ''}`, '');
    if (t.code && t.code.length) {
      const width = String(t.start + t.code.length).length;
      const body = t.code.map((l, i) => `${String(t.start + 1 + i).padStart(width)}  ${l}`).join('\n');
      const f = fence(body);
      out.push(f, body, f, '');
    }
    t.comments.forEach((c, i) => out.push(i ? `Also: ${c}` : c));
  });
  return `${out.join('\n')}\n`;
}

module.exports = { MAX_ANCHOR, splitLines, anchorOf, relocate, reviewText, fence, codeSpan };
