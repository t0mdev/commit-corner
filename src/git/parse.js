'use strict';

const crypto = require('crypto');

/**
 * Pure parsers for git's machine-readable output formats. No I/O here, so
 * everything in this file is unit-tested directly.
 */

const FS = '\x1f'; // field separator used in our --format strings
const RS = '\x1e'; // record separator used in our --format strings

/**
 * Commit fields, git's own first (SHAs, dates, ref names: none can contain a control byte),
 * then the text whoever made the commit chose (names, e-mails, subject, body), which can hold
 * any byte but NUL — including our field separator. A crafted commit can at most garble its
 * own text fields, never its SHA, parents, dates or refs, and never another commit.
 */
const FIELDS = ['%H', '%P', '%at', '%ct', '%D', '%an', '%ae', '%cn', '%ce', '%s'];
/** Format string for `git log` that pairs with parseLog(). Records end in NUL. */
const LOG_FORMAT = FIELDS.join('%x1f') + '%x00';
/** Same as LOG_FORMAT plus the raw body (subject + message); parse with parseLog(text, {body: true}). */
const LOG_FORMAT_WITH_BODY = [...FIELDS, '%B'].join('%x1f') + '%x00';

const HEX_SHA = /^[0-9a-f]{40,64}$/;
/**
 * A path as git prints it outside -z output: names with control characters, quotes or
 * backslashes come C-quoted ("tab\\there.txt" with the quotes). Returns the real name.
 */
function unquoteC(s) {
  if (!/^".*"$/s.test(s)) return s;
  const bytes = [];
  const body = s.slice(1, -1);
  const ESC = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, '\\': 92 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = body[++i];
    if (/[0-7]/.test(next) && /^[0-7]{3}$/.test(body.slice(i, i + 3))) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(ESC[next] !== undefined ? ESC[next] : next.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

/** One-line text from repository data: control characters (newlines, separators) become spaces. */
const oneLine = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ');

/**
 * @typedef {{sha:string, parents:string[], authorName:string, authorEmail:string, authorDate:number,
 *   committerName:string, committerEmail:string, commitDate:number, refs:Ref[], subject:string, body?:string}} Commit
 * @typedef {{name:string, type:'head'|'branch'|'remote'|'tag'|'pr'|'internal'|'other', fullName:string, isHead?:boolean}} Ref
 */

/**
 * Commits of `git log --format=LOG_FORMAT` (or LOG_FORMAT_WITH_BODY with `{body: true}`).
 * @param {string} text
 * @param {{body?: boolean}} [o]
 */
function parseLog(text, o = {}) {
  const commits = [];
  for (const record of text.split('\0')) {
    const c = parseRecord(record, o);
    if (c) commits.push(c);
  }
  return commits;
}

/** One commit record (FIELDS joined by FS), or undefined when it is not one. */
function parseRecord(record, o = {}) {
  record = record.replace(/^\n+/, '');
  const f = record.split(FS);
  if (f.length < FIELDS.length) return undefined;
  const parents = f[1] ? f[1].split(' ') : [];
  // Anything that does not look like git's own fields (hex SHAs, numeric dates) is not a commit.
  if (!HEX_SHA.test(f[0]) || !parents.every((p) => HEX_SHA.test(p)) || !/^\d+$/.test(f[2]) || !/^\d+$/.test(f[3])) return undefined;
  const commit = {
    sha: f[0],
    parents,
    authorDate: Number(f[2]) * 1000,
    commitDate: Number(f[3]) * 1000,
    refs: parseDecorations(f[4]),
    authorName: oneLine(f[5]),
    authorEmail: oneLine(f[6]),
    committerName: oneLine(f[7]),
    committerEmail: oneLine(f[8]),
    // A subject is one line by definition; any other control byte could only come from a crafted commit.
    subject: oneLine(o.body ? f[9] : f.slice(9).join(' ')),
  };
  if (o.body) commit.body = f.slice(10).join(FS).replace(/\n+$/, '');
  return commit;
}

/**
 * Commit records followed by more output each (a patch, --shortstat, --name-status), framed
 * by markers with a random nonce: commit text can contain any separator byte we could pick,
 * but not a nonce it has never seen, so a crafted commit cannot start or end a record.
 * @param {string} [nonce] fixed only in tests
 * @returns {{format: string, split: (text: string) => {commit: Commit, tail: string}[]}}
 */
function framedLog(nonce = crypto.randomBytes(8).toString('hex')) {
  const start = `\x1e${nonce}`;
  const end = `\x1d${nonce}`;
  return {
    format: `%x1e${nonce}${FIELDS.join('%x1f')}%x1d${nonce}`,
    split(text) {
      const out = [];
      for (const chunk of text.split(start)) {
        const at = chunk.indexOf(end);
        if (at < 0) continue;
        const commit = parseRecord(chunk.slice(0, at));
        if (commit) out.push({ commit, tail: chunk.slice(at + end.length) });
      }
      return out;
    },
  };
}

/**
 * Parse `%D` output produced with --decorate=full, e.g.
 * "HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1".
 * @returns {Ref[]}
 */
function parseDecorations(text) {
  if (!text) return [];
  const refs = [];
  for (let part of text.split(', ')) {
    part = part.trim();
    if (!part) continue;
    if (part.startsWith('HEAD -> ')) {
      refs.push({ name: 'HEAD', type: 'head', fullName: 'HEAD' });
      const r = refFromFullName(part.slice(8));
      r.isHead = true;
      refs.push(r);
    } else if (part === 'HEAD') {
      refs.push({ name: 'HEAD', type: 'head', fullName: 'HEAD' });
    } else if (part.startsWith('tag: ')) {
      refs.push(refFromFullName(part.slice(5)));
    } else {
      refs.push(refFromFullName(part));
    }
  }
  return refs;
}

function refFromFullName(fullName) {
  let r;
  if (fullName.startsWith('refs/heads/')) r = { name: fullName.slice(11), type: 'branch', fullName };
  else if (fullName.startsWith('refs/remotes/')) r = { name: fullName.slice(13), type: 'remote', fullName };
  else if (fullName.startsWith('refs/tags/')) r = { name: fullName.slice(10), type: 'tag', fullName };
  else {
    // Pull requests this extension fetched (refs/commit-corner/pr/<remote>/<n>/head): "PR #n".
    // Their merge and base refs are bookkeeping, never shown.
    const pr = /^refs\/commit-corner\/pr\/(.+)\/(\d+)\/(head|merge|base)$/.exec(fullName);
    if (pr) r = { name: `PR #${pr[2]}`, type: pr[3] === 'head' ? 'pr' : 'internal', number: Number(pr[2]), remote: pr[1], fullName };
    else r = { name: fullName.replace(/^refs\//, ''), type: 'other', fullName };
  }
  // What to hand to git: the short name, unless git could read it as an option ("--output=…").
  r.rev = r.name.startsWith('-') || r.type === 'pr' || r.type === 'internal' ? fullName : r.name;
  return r;
}

/**
 * Parse `git status --porcelain=v2 -z --branch`.
 * @typedef {{path:string, origPath?:string, x:string, y:string, kind:'changed'|'renamed'|'unmerged'|'untracked'|'ignored', submodule:boolean, modeHead?:string, modeIndex?:string, modeWorktree?:string}} StatusEntry
 * @returns {{branch:{oid:string|null, head:string|null, upstream:string|null, ahead:number, behind:number}, entries:StatusEntry[]}}
 */
function parseStatus(text) {
  const branch = { oid: null, head: null, upstream: null, ahead: 0, behind: 0 };
  const entries = [];
  const parts = text.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# ')) {
      const [key, ...rest] = line.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') branch.oid = value === '(initial)' ? null : value;
      else if (key === 'branch.head') branch.head = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') branch.upstream = value;
      else if (key === 'branch.ab') {
        const m = /\+(\d+) -(\d+)/.exec(value);
        if (m) {
          branch.ahead = +m[1];
          branch.behind = +m[2];
        }
      }
      continue;
    }
    const type = line[0];
    if (type === '1') {
      const f = splitN(line, ' ', 9);
      entries.push({ kind: 'changed', x: f[1][0], y: f[1][1], submodule: f[2][0] === 'S', modeHead: f[3], modeIndex: f[4], modeWorktree: f[5], path: f[8] });
    } else if (type === '2') {
      const f = splitN(line, ' ', 10);
      const origPath = parts[++i];
      entries.push({ kind: 'renamed', x: f[1][0], y: f[1][1], submodule: f[2][0] === 'S', modeHead: f[3], modeIndex: f[4], modeWorktree: f[5], score: f[8], path: f[9], origPath });
    } else if (type === 'u') {
      const f = splitN(line, ' ', 11);
      entries.push({ kind: 'unmerged', x: f[1][0], y: f[1][1], submodule: f[2][0] === 'S', modeWorktree: f[6], path: f[10] });
    } else if (type === '?') {
      entries.push({ kind: 'untracked', x: '?', y: '?', submodule: false, path: line.slice(2) });
    } else if (type === '!') {
      entries.push({ kind: 'ignored', x: '!', y: '!', submodule: false, path: line.slice(2) });
    }
  }
  return { branch, entries };
}

/** Split into at most n fields; the last field keeps any remaining separators (paths may contain spaces). */
function splitN(text, sep, n) {
  const out = [];
  let start = 0;
  for (let k = 0; k < n - 1; k++) {
    const idx = text.indexOf(sep, start);
    if (idx < 0) break;
    out.push(text.slice(start, idx));
    start = idx + sep.length;
  }
  out.push(text.slice(start));
  return out;
}

/**
 * Parse `--name-status -z` output (diff, diff-tree, log).
 * @typedef {{status:string, path:string, origPath?:string, score?:number}} FileChange
 * @returns {FileChange[]}
 */
function parseNameStatus(text) {
  const parts = text.split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    const status = code[0];
    if (!/^[ACDMRTUXB]/.test(status)) continue;
    if (status === 'R' || status === 'C') {
      const origPath = parts[++i];
      const path = parts[++i];
      out.push({ status, origPath, path, score: Number(code.slice(1)) || undefined });
    } else {
      out.push({ status, path: parts[++i] });
    }
  }
  return out;
}

/**
 * Parse `diff --raw -z --no-abbrev`: the new blob id of every changed file, by (new) path;
 * deleted files have none. Content fingerprints, e.g. for "viewed" marks.
 * @returns {Map<string, string>}
 */
function parseRawBlobs(text) {
  const parts = text.split('\0');
  const out = new Map();
  for (let i = 0; i < parts.length; i++) {
    const m = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) ([A-Z])/.exec(parts[i]);
    if (!m) continue;
    if (m[2] === 'R' || m[2] === 'C') i++; // the old path comes first
    const file = parts[++i];
    if (file !== undefined && m[2] !== 'D') out.set(file, m[1]);
  }
  return out;
}

/**
 * Parse `--numstat -z`. Returns a map keyed by (new) path.
 * @returns {Map<string, {added:number|null, deleted:number|null, binary:boolean}>}
 */
function parseNumstat(text) {
  const map = new Map();
  const parts = text.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
    if (!m) continue;
    let path = m[3];
    if (path === '') {
      // rename: "a\td\t\0old\0new"
      i++;
      path = parts[++i];
    }
    const binary = m[1] === '-';
    map.set(path, { added: binary ? null : +m[1], deleted: binary ? null : +m[2], binary });
  }
  return map;
}

/**
 * Parse `git for-each-ref` with REF_FORMAT.
 */
const REF_FORMAT = ['%(refname)', '%(objectname)', '%(upstream)', '%(upstream:track)', '%(HEAD)', '%(creatordate:unix)', '%(*objectname)', '%(subject)'].join('%1f');

/** @returns {{fullName:string, name:string, type:string, sha:string, upstream?:string, ahead:number, behind:number, gone:boolean, isHead:boolean, date:number, subject:string, peeled?:string}[]} */
function parseRefs(text) {
  const refs = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const f = line.split(FS);
    const ref = refFromFullName(f[0]);
    const track = f[3] || '';
    const ahead = /ahead (\d+)/.exec(track);
    const behind = /behind (\d+)/.exec(track);
    refs.push({
      ...ref,
      sha: f[6] || f[1],
      tagObject: f[6] ? f[1] : undefined,
      upstream: f[2] ? refFromFullName(f[2]).name : undefined,
      ahead: ahead ? +ahead[1] : 0,
      behind: behind ? +behind[1] : 0,
      gone: track.includes('gone'),
      isHead: f[4] === '*',
      date: Number(f[5]) * 1000,
      subject: f.slice(7).join(FS),
    });
  }
  // Symbolic refs like refs/remotes/origin/HEAD are noise in lists.
  return refs.filter((r) => !(r.type === 'remote' && r.name.endsWith('/HEAD')));
}

/** Parse `git stash list --format=%gd%x1f%H%x1f%ct%x1f%P%x1f%gs`. */
function parseStashes(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const f = line.split(FS);
    const m = /\{(\d+)\}/.exec(f[0]);
    const message = f.slice(4).join(FS);
    const branchMatch = /^(?:WIP on|On) ([^:]+):/.exec(message);
    out.push({
      ref: f[0],
      index: m ? +m[1] : out.length,
      sha: f[1],
      date: Number(f[2]) * 1000,
      parents: f[3] ? f[3].split(' ') : [],
      message,
      branch: branchMatch ? branchMatch[1] : undefined,
      description: message.replace(/^(?:WIP on|On) [^:]+: /, ''),
    });
  }
  return out;
}

/** Parse `git worktree list --porcelain`. */
function parseWorktrees(text, nul = false) {
  const out = [];
  let cur = null;
  // With -z (git 2.36+) every line ends in NUL, so paths may contain newlines.
  for (const line of text.split(nul ? '\0' : '\n')) {
    if (!line) {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'worktree') {
      if (cur) out.push(cur);
      cur = { path: value, head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
    } else if (!cur) continue;
    else if (key === 'HEAD') cur.head = value;
    else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'detached') cur.detached = true;
    else if (key === 'bare') cur.bare = true;
    else if (key === 'locked') {
      cur.locked = true;
      cur.lockReason = value || undefined;
    } else if (key === 'prunable') {
      cur.prunable = true;
      cur.prunableReason = value || undefined;
    }
  }
  if (cur) out.push(cur);
  out.forEach((w, i) => (w.isMain = i === 0));
  return out;
}

/**
 * Parse `git blame --incremental`.
 * @returns {{commits: Map<string, BlameCommit>, lines: (string|undefined)[]}} lines[i] = sha for 0-based final line i
 * @typedef {{sha:string, author:string, authorMail:string, authorTime:number, committer:string, committerTime:number, summary:string, filename:string, previous?:string, previousFilename?:string, uncommitted:boolean}} BlameCommit
 */
function parseBlameIncremental(text) {
  const commits = new Map();
  const lines = [];
  /** sourceLines[i]: 0-based line number in the blamed commit's version of the file. */
  const sourceLines = [];
  const rows = text.split('\n');
  let cur = null;
  for (const row of rows) {
    if (!row) continue;
    const header = /^([0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+) (\d+)$/.exec(row);
    if (header) {
      const sha = header[1];
      const sourceLine = +header[2] - 1;
      const finalLine = +header[3] - 1;
      const count = +header[4];
      for (let k = 0; k < count; k++) {
        lines[finalLine + k] = sha;
        sourceLines[finalLine + k] = sourceLine + k;
      }
      cur = commits.get(sha);
      if (!cur) {
        cur = { sha, author: '', authorMail: '', authorTime: 0, committer: '', committerTime: 0, summary: '', filename: '', uncommitted: /^0+$/.test(sha) };
        commits.set(sha, cur);
      }
      continue;
    }
    if (!cur) continue;
    const sp = row.indexOf(' ');
    const key = sp < 0 ? row : row.slice(0, sp);
    const value = sp < 0 ? '' : row.slice(sp + 1);
    switch (key) {
      case 'author': cur.author = value; break;
      case 'author-mail': cur.authorMail = value.replace(/^<|>$/g, ''); break;
      case 'author-time': cur.authorTime = Number(value) * 1000; break;
      case 'committer': cur.committer = value; break;
      case 'committer-time': cur.committerTime = Number(value) * 1000; break;
      case 'summary': cur.summary = value; break;
      case 'previous': {
        const s = value.indexOf(' ');
        cur.previous = value.slice(0, s);
        cur.previousFilename = unquoteC(value.slice(s + 1));
        break;
      }
      case 'filename': cur.filename = unquoteC(value); break;
      default: break;
    }
  }
  return { commits, lines, sourceLines };
}

/** Parse `git ls-remote` output. */
function parseLsRemote(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    out.push({ sha: line.slice(0, tab), ref: line.slice(tab + 1) });
  }
  return out;
}

/** Group GitHub's `refs/pull/<n>/{head,merge}` refs into pull request records, newest number first. */
function parsePullRefs(lsRemote) {
  const byNumber = new Map();
  for (const { sha, ref } of lsRemote) {
    const m = /^refs\/pull\/(\d+)\/(head|merge)$/.exec(ref);
    if (!m) continue;
    const n = +m[1];
    const rec = byNumber.get(n) || { number: n, head: undefined, merge: undefined };
    rec[m[2]] = sha;
    byNumber.set(n, rec);
  }
  return [...byNumber.values()].filter((r) => r.head).sort((a, b) => b.number - a.number);
}

/** True for GitHub's pull request refs, which only GitHub may update (never push to them). */
function isPullRequestRef(ref) {
  return ref.startsWith('refs/pull/');
}

/** Parse `git remote -v`. */
function parseRemotes(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    // URLs may contain spaces ("C:/Users/John Doe/repo.git"); the name never does.
    const m = /^([^\t\s]+)\t(.+) \((fetch|push)\)$/.exec(line);
    if (!m) continue;
    const r = map.get(m[1]) || { name: m[1], fetchUrl: undefined, pushUrl: undefined };
    if (m[3] === 'fetch') r.fetchUrl = m[2];
    else r.pushUrl = m[2];
    map.set(m[1], r);
  }
  return [...map.values()];
}

/** Parse `git reflog --format=%H%x1f%gd%x1f%gs%x1f%ct`. */
function parseReflog(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const f = line.split(FS);
    out.push({ sha: f[0], selector: f[1], message: f[2], date: Number(f[3]) * 1000 });
  }
  return out;
}

/**
 * Parse the legacy three-argument `git merge-tree <base> <a> <b>` output and
 * return the paths that would conflict. Used on git < 2.38, which lacks
 * `merge-tree --write-tree`. A section conflicts when it carries conflict
 * markers (content conflict) or when one side deleted a file the other side
 * changed (modify/delete).
 */
function parseLegacyMergeTree(text) {
  const conflicts = new Set();
  // Section headers are lowercase words ("changed in both"); diff lines start with + - @ or space.
  const sections = text.split(/^(?=[a-z])/m);
  for (const section of sections) {
    const header = section.split('\n', 1)[0];
    const entries = [...section.matchAll(/^ {2}(our|their|result|base) +(\d+) ([0-9a-f]+) (.+)$/gm)].map((m) => ({ side: m[1], sha: m[3], path: m[4] }));
    if (!entries.length) continue;
    let conflict = false;
    if (/^(changed|added) in both/.test(header)) conflict = /^\+<<<<<<< /m.test(section);
    else if (/^removed in (local|remote)/.test(header)) {
      const base = entries.find((e) => e.side === 'base');
      const kept = entries.find((e) => e.side === 'our' || e.side === 'their');
      conflict = !!(base && kept && base.sha !== kept.sha);
    }
    if (conflict) conflicts.add(entries[entries.length - 1].path);
  }
  return [...conflicts];
}

/** Parse `git merge-tree --write-tree --name-only --no-messages` (git >= 2.38). */
function parseWriteTreeConflicts(text, exitCode, nul = false) {
  if (exitCode === 0) return [];
  // -z: NUL-separated (names with tabs, quotes or newlines come unquoted).
  const lines = text.split(nul ? '\0' : '\n');
  // first line is the tree OID; then conflicted paths until an empty line.
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) break;
    out.push(lines[i]);
  }
  return [...new Set(out)];
}

/** Commits of `git log -L` (framedLog), with the file's paths in each commit's patch. */
function parseLineLog(text, framed) {
  return framed.split(text).map(({ commit, tail }) => {
    const minus = /^--- (?:a\/(.*)|(\/dev\/null))$/m.exec(tail);
    const plus = /^\+\+\+ (?:b\/(.*)|(\/dev\/null))$/m.exec(tail);
    if (plus) commit.patchPath = plus[1] || undefined;
    if (minus) commit.patchOldPath = minus[2] || minus[1];
    return commit;
  });
}

/**
 * Parse a `--shortstat` summary line ("3 files changed, 10 insertions(+), 2 deletions(-)").
 * @returns {{files:number, added:number, deleted:number}} zeros when there is none
 */
function parseShortstat(text) {
  const m = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(text || '');
  return m ? { files: Number(m[1]), added: Number(m[2] || 0), deleted: Number(m[3] || 0) } : { files: 0, added: 0, deleted: 0 };
}

/** Commits of `git log --shortstat` (framedLog), each with a `stats` field. */
function parseLogWithStats(text, framed) {
  return framed.split(text).map(({ commit, tail }) => Object.assign(commit, { stats: parseShortstat(tail) }));
}

module.exports = {
  oneLine,
  unquoteC,
  HEX_SHA,
  parseShortstat,
  parseLogWithStats,
  FS,
  RS,
  LOG_FORMAT,
  LOG_FORMAT_WITH_BODY,
  framedLog,
  parseRecord,
  REF_FORMAT,
  parseLog,
  parseDecorations,
  refFromFullName,
  parseStatus,
  parseNameStatus,
  parseRawBlobs,
  parseNumstat,
  parseRefs,
  parseStashes,
  parseWorktrees,
  parseBlameIncremental,
  parseLsRemote,
  parsePullRefs,
  isPullRequestRef,
  parseRemotes,
  parseReflog,
  parseLegacyMergeTree,
  parseWriteTreeConflicts,
  parseLineLog,
  splitN,
};
