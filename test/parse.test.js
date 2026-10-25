'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/git/parse');

test('parseStatus: branch header, ordinary, rename, unmerged, untracked', () => {
  const text = [
    '# branch.oid 1234567890123456789012345678901234567890',
    '# branch.head feature/x',
    '# branch.upstream origin/feature/x',
    '# branch.ab +2 -3',
    '1 M. N... 100644 100644 100644 aaaa bbbb src/a file.js',
    '1 .M N... 100644 100644 100644 aaaa bbbb b.js',
    '2 R. N... 100644 100644 100644 aaaa bbbb R100 new name.js',
    'old name.js',
    'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
    '? untracked dir/x.txt',
    '',
  ].join('\0');
  const s = P.parseStatus(text);
  assert.deepEqual(s.branch, { oid: '1234567890123456789012345678901234567890', head: 'feature/x', upstream: 'origin/feature/x', ahead: 2, behind: 3 });
  assert.equal(s.entries.length, 5);
  assert.equal(s.entries[0].path, 'src/a file.js');
  assert.equal(s.entries[0].x, 'M');
  assert.equal(s.entries[1].y, 'M');
  assert.equal(s.entries[2].kind, 'renamed');
  assert.equal(s.entries[2].path, 'new name.js');
  assert.equal(s.entries[2].origPath, 'old name.js');
  assert.equal(s.entries[3].kind, 'unmerged');
  assert.equal(s.entries[3].path, 'conflict.txt');
  assert.equal(s.entries[4].path, 'untracked dir/x.txt');
});

test('parseStatus: initial commit and detached head', () => {
  const s = P.parseStatus('# branch.oid (initial)\0# branch.head (detached)\0');
  assert.equal(s.branch.oid, null);
  assert.equal(s.branch.head, null);
});

test('parseDecorations distinguishes ref kinds', () => {
  const refs = P.parseDecorations('HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1.0, refs/stash');
  assert.deepEqual(refs.map((r) => [r.type, r.name]), [
    ['head', 'HEAD'], ['branch', 'main'], ['remote', 'origin/main'], ['tag', 'v1.0'], ['other', 'stash'],
  ]);
  assert.equal(refs[1].isHead, true);
});

test('parseLog handles bodies containing separators-free multi-line text', () => {
  const rec = ['a'.repeat(40), 'b'.repeat(40) + ' ' + 'c'.repeat(40), '10', '20', '', 'Ann', 'ann@x', 'Bob', 'bob@x', 'Subject', 'Subject\n\nBody line\n'].join(P.FS) + '\0';
  const [c] = P.parseLog('\n' + rec, { body: true });
  assert.equal(c.parents.length, 2);
  assert.equal(c.authorDate, 10000);
  assert.equal(c.body, 'Subject\n\nBody line');
});

test('parseNameStatus with renames and copies', () => {
  const out = P.parseNameStatus('M\0a.js\0R087\0old.js\0new.js\0C100\0x\0y\0D\0gone\0');
  assert.deepEqual(out, [
    { status: 'M', path: 'a.js' },
    { status: 'R', origPath: 'old.js', path: 'new.js', score: 87 },
    { status: 'C', origPath: 'x', path: 'y', score: 100 },
    { status: 'D', path: 'gone' },
  ]);
});

test('parseNumstat including binary and rename records', () => {
  const m = P.parseNumstat('3\t1\ta.js\0-\t-\timg.png\0' + '2\t2\t\0old.js\0new.js\0');
  assert.deepEqual(m.get('a.js'), { added: 3, deleted: 1, binary: false });
  assert.deepEqual(m.get('img.png'), { added: null, deleted: null, binary: true });
  assert.deepEqual(m.get('new.js'), { added: 2, deleted: 2, binary: false });
});

test('parseRefs with tracking info and peeled tags', () => {
  const line = (...f) => f.join(P.FS);
  const text = [
    line('refs/heads/main', 'a1', 'refs/remotes/origin/main', '[ahead 1, behind 2]', '*', '100', '', 'msg'),
    line('refs/heads/old', 'a2', 'refs/remotes/origin/old', '[gone]', ' ', '100', '', 'msg'),
    line('refs/remotes/origin/HEAD', 'a1', '', '', ' ', '100', '', ''),
    line('refs/tags/v1', 'tagobj', '', '', ' ', '100', 'commit1', 'release'),
  ].join('\n');
  const refs = P.parseRefs(text);
  assert.equal(refs.length, 3);
  assert.equal(refs[0].ahead, 1);
  assert.equal(refs[0].behind, 2);
  assert.equal(refs[0].isHead, true);
  assert.equal(refs[0].upstream, 'origin/main');
  assert.equal(refs[1].gone, true);
  assert.equal(refs[2].sha, 'commit1');
});

test('parseStashes', () => {
  const s = P.parseStashes(['stash@{0}', 'aaa', '100', 'p1 p2 p3', 'On main: my message'].join(P.FS) + '\n' + ['stash@{1}', 'bbb', '90', 'p1 p2', 'WIP on dev: abc123 subject'].join(P.FS));
  assert.equal(s.length, 2);
  assert.equal(s[0].description, 'my message');
  assert.equal(s[0].branch, 'main');
  assert.equal(s[0].parents.length, 3);
  assert.equal(s[1].index, 1);
  assert.equal(s[1].branch, 'dev');
});

test('parseWorktrees', () => {
  const w = P.parseWorktrees('worktree /a\nHEAD 111\nbranch refs/heads/main\n\nworktree /b\nHEAD 222\ndetached\nlocked because\n\n');
  assert.equal(w.length, 2);
  assert.equal(w[0].branch, 'main');
  assert.equal(w[0].isMain, true);
  assert.equal(w[1].detached, true);
  assert.equal(w[1].lockReason, 'because');
});

test('parseBlameIncremental maps lines to commits', () => {
  const sha = 'a'.repeat(40);
  const zero = '0'.repeat(40);
  const text = [
    `${sha} 1 1 2`, 'author Ann', 'author-mail <ann@x>', 'author-time 100', 'committer Ann', 'committer-time 100', 'summary first', 'filename f.txt',
    `${zero} 3 3 1`, 'author Not Committed Yet', 'author-time 200', 'summary Version of f.txt from f.txt', 'filename f.txt',
    `${sha} 4 4 1`, 'filename f.txt', '',
  ].join('\n');
  const b = P.parseBlameIncremental(text);
  assert.deepEqual(b.lines, [sha, sha, zero, sha]);
  assert.equal(b.commits.get(sha).author, 'Ann');
  assert.equal(b.commits.get(sha).authorMail, 'ann@x');
  assert.equal(b.commits.get(zero).uncommitted, true);
});

test('parsePullRefs groups head/merge refs by number', () => {
  const prs = P.parsePullRefs(P.parseLsRemote('a\trefs/pull/1/head\nb\trefs/pull/2/head\nc\trefs/pull/2/merge\nd\trefs/heads/main\ne\trefs/pull/3/merge\n'));
  assert.deepEqual(prs, [{ number: 2, head: 'b', merge: 'c' }, { number: 1, head: 'a', merge: undefined }]);
  assert.ok(P.isPullRequestRef('refs/pull/1/head'));
  assert.ok(!P.isPullRequestRef('refs/heads/main'));
});

test('parseRemotes', () => {
  const r = P.parseRemotes('origin\tgit@github.com:o/r.git (fetch)\norigin\tgit@github.com:o/r.git (push)\n');
  assert.deepEqual(r, [{ name: 'origin', fetchUrl: 'git@github.com:o/r.git', pushUrl: 'git@github.com:o/r.git' }]);
});

test('parseLegacyMergeTree finds content and modify/delete conflicts', () => {
  const text = [
    'changed in both',
    '  base   100644 1111111111111111111111111111111111111111 a.txt',
    '  our    100644 2222222222222222222222222222222222222222 a.txt',
    '  their  100644 3333333333333333333333333333333333333333 a.txt',
    '@@ -1 +1,5 @@',
    '+<<<<<<< .our',
    ' x',
    '+=======',
    '+y',
    '+>>>>>>> .their',
    'changed in both',
    '  base   100644 1111111111111111111111111111111111111111 clean.txt',
    '  our    100644 2222222222222222222222222222222222222222 clean.txt',
    '  their  100644 3333333333333333333333333333333333333333 clean.txt',
    '@@ -1,2 +1,2 @@',
    '-a',
    '+b',
    'removed in remote',
    '  base   100644 1111111111111111111111111111111111111111 gone.txt',
    '  our    100644 4444444444444444444444444444444444444444 gone.txt',
    '@@ -1 +0,0 @@',
    '-x',
    '',
  ].join('\n');
  assert.deepEqual(P.parseLegacyMergeTree(text).sort(), ['a.txt', 'gone.txt']);
});

test('parseWriteTreeConflicts', () => {
  assert.deepEqual(P.parseWriteTreeConflicts('tree\n', 0), []);
  assert.deepEqual(P.parseWriteTreeConflicts('tree\na.txt\nb.txt\n\ninfo', 1), ['a.txt', 'b.txt']);
});

test('splitN keeps separators in the last field', () => {
  assert.deepEqual(P.splitN('a b c d e', ' ', 3), ['a', 'b', 'c d e']);
});
