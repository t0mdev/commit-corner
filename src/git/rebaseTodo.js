'use strict';

/**
 * Parse and serialize git's interactive rebase todo list.
 * Unknown lines (exec, label, reset, merge, break, update-ref ...) are kept
 * verbatim so a todo written by git round-trips without loss.
 */

const ACTIONS = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];
const ALIASES = { p: 'pick', r: 'reword', e: 'edit', s: 'squash', f: 'fixup', d: 'drop' };

/**
 * @returns {{entries: ({type:'commit', action:string, sha:string, subject:string, flag?:string} | {type:'other', text:string})[], comments: string[]}}
 */
function parseTodo(text) {
  const entries = [];
  const comments = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    if (line.startsWith('#')) {
      comments.push(line);
      continue;
    }
    const m = /^(\w+)(?:\s+(-[cC]))?\s+([0-9a-f]{4,64})(?:\s+(.*))?$/.exec(line.trim());
    const action = m && (ALIASES[m[1]] || m[1]);
    if (m && ACTIONS.includes(action)) {
      entries.push({ type: 'commit', action, sha: m[3], subject: m[4] || '', flag: m[2] });
    } else entries.push({ type: 'other', text: line });
  }
  return { entries, comments };
}

/**
 * @param {ReturnType<typeof parseTodo>['entries']} entries
 * @param {{messageFiles?: Map<number, string>}} [opts] messageFiles: entry index -> path of a
 *        message file; an `exec git commit --amend -F` line is emitted after that entry.
 */
function serializeTodo(entries, opts = {}) {
  const lines = [];
  // Every line git reads is checked: a newline smuggled into a subject or a line would become
  // an extra todo command (e.g. "exec …"), so subjects are flattened and commands validated.
  const oneLine = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ');
  entries.forEach((e, i) => {
    if (e.type === 'commit') {
      if (!ACTIONS.includes(e.action) || !/^[0-9a-f]{4,64}$/.test(e.sha) || (e.flag && !/^-[cC]$/.test(e.flag))) {
        throw new Error(`Invalid rebase todo entry: ${oneLine(e.action)} ${oneLine(e.sha)}`);
      }
      lines.push(`${e.action}${e.flag ? ' ' + e.flag : ''} ${e.sha} ${oneLine(e.subject)}`.trimEnd());
    } else lines.push(oneLine(e.text));
    const file = opts.messageFiles && opts.messageFiles.get(i);
    // New messages: like git's own reword, run only the commit-msg hook (pre-commit linters must not
    // stop a rebase), then amend with the configured git (commitCorner.gitPath may not be on PATH).
    if (file) {
      const git = shellQuote(opts.git || 'git');
      const msg = shellQuote(file);
      lines.push(`exec h="$(${git} rev-parse --git-path hooks/commit-msg)"; if [ -x "$h" ]; then "$h" ${msg} || exit 1; fi; ${git} commit --amend --allow-empty --only --no-verify -F ${msg}`);
    }
  });
  return lines.join('\n') + '\n';
}

/** Quote for git's exec lines, which run through `sh -c`. */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Validate a todo before running it. Returns a human readable problem or undefined.
 */
function validateTodo(entries) {
  const commits = entries.filter((e) => e.type === 'commit' && e.action !== 'drop');
  if (!commits.length) return undefined;
  const first = commits[0];
  if (first.action === 'squash' || first.action === 'fixup') {
    return `The first commit cannot be "${first.action}": there is no previous commit to fold it into.`;
  }
  return undefined;
}

/**
 * For each entry, the index of the commit that will receive its message when
 * squashed/fixed-up (useful for previews). Returns the indices of the commits
 * that end up as distinct commits ("group heads").
 */
function groupHeads(entries) {
  const heads = [];
  let current = -1;
  entries.forEach((e, i) => {
    if (e.type !== 'commit' || e.action === 'drop') return;
    if ((e.action === 'squash' || e.action === 'fixup') && current >= 0) return;
    current = i;
    heads.push(i);
  });
  return heads;
}

/** Index of the last non-dropped commit entry in the group starting at `head`. */
function groupEnd(entries, head) {
  let end = head;
  for (let i = head + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== 'commit') break;
    if (e.action === 'drop') continue;
    if (e.action === 'squash' || e.action === 'fixup') end = i;
    else break;
  }
  return end;
}

module.exports = { parseTodo, serializeTodo, validateTodo, groupHeads, groupEnd, shellQuote, ACTIONS };
