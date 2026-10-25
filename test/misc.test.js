'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { combineCommitChanges } = require('../src/git/multiCommit');
const { githubWebUrl, githubFileUrl } = require('../src/git/remoteUrl');
const T = require('../src/git/rebaseTodo');

test('combineCommitChanges: before from oldest touching commit, after from newest', () => {
  const files = combineCommitChanges([
    { sha: 'c1', parent: 'p1', changes: [{ status: 'M', path: 'a' }, { status: 'A', path: 'new' }] },
    { sha: 'c3', parent: 'p3', changes: [{ status: 'M', path: 'a' }, { status: 'M', path: 'b' }] },
  ]);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.deepEqual([byPath.a.beforeRef, byPath.a.afterRef, byPath.a.status], ['p1', 'c3', 'M']);
  assert.deepEqual([byPath.b.beforeRef, byPath.b.afterRef], ['p3', 'c3']);
  assert.deepEqual([byPath.new.beforeRef, byPath.new.afterRef, byPath.new.status], [null, 'c1', 'A']);
});

test('combineCommitChanges follows renames and drops add+delete', () => {
  const files = combineCommitChanges([
    { sha: 'c1', parent: 'p', changes: [{ status: 'M', path: 'old' }, { status: 'A', path: 'tmp' }] },
    { sha: 'c2', parent: 'c1', changes: [{ status: 'R', origPath: 'old', path: 'new' }, { status: 'D', path: 'tmp' }] },
  ]);
  assert.equal(files.length, 1);
  assert.deepEqual(files[0], {
    status: 'R', path: 'new', origPath: 'old', beforeRef: 'p', beforePath: 'old', afterRef: 'c2', afterPath: 'new', commits: ['c1', 'c2'], key: 'new',
  });
});

test('githubWebUrl understands common remote URL shapes', () => {
  for (const u of ['https://github.com/o/r.git', 'git@github.com:o/r.git', 'ssh://git@github.com/o/r', 'https://user@github.com/o/r/', 'git@ssh.github.com:o/r.git']) {
    assert.equal(githubWebUrl(u), 'https://github.com/o/r', u);
  }
  // GitHub.com only: other hosts (GitLab, Bitbucket, GitHub Enterprise) are not supported.
  assert.equal(githubWebUrl('git@gitlab.com:o/r.git'), undefined);
  assert.equal(githubWebUrl('git@ghe.corp:o/r.git'), undefined);
  assert.equal(githubFileUrl('https://github.com/o/r', 'abc', 'dir/a b.js', 3, 5), 'https://github.com/o/r/blob/abc/dir/a%20b.js#L3-L5');
});

test('rebase todo round trip keeps unknown lines', () => {
  const text = 'pick abc1234 first\nexec make test\nf def5678 second\n# comment\n';
  const { entries, comments } = T.parseTodo(text);
  assert.equal(entries.length, 3);
  assert.equal(entries[2].action, 'fixup');
  assert.equal(comments.length, 1);
  assert.equal(T.serializeTodo(entries), 'pick abc1234 first\nexec make test\nfixup def5678 second\n');
});

test('rebase todo validation and groups', () => {
  const { entries } = T.parseTodo('squash a1a1a1 x\npick b2b2b2 y\n');
  assert.match(T.validateTodo(entries), /first commit/);
  const e2 = T.parseTodo('pick a1a1a1 x\nsquash b2b2b2 y\ndrop c3c3c3 z\nfixup d4d4d4 w\npick e5e5e5 v\n').entries;
  assert.deepEqual(T.groupHeads(e2), [0, 4]);
  assert.equal(T.groupEnd(e2, 0), 3);
  const withMsg = T.serializeTodo(e2.slice(0, 1), { messageFiles: new Map([[0, "/tmp/it's"]]) });
  assert.match(withMsg, /'git' commit --amend .*--no-verify -F '\/tmp\/it'\\''s'/);
  assert.match(withMsg, /hooks\/commit-msg/);
});

test('askpass helper round-trips a prompt through the private socket', async (t) => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { execFile } = require('child_process');
  const { AskpassServer } = require('../src/git/askpass');
  const seen = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-askpass-test-'));
  const flags = [];
  const server = new AskpassServer(async (p, o) => {
    seen.push(p);
    flags.push(`${o.quiet ? 'quiet' : 'ui'}:${o.ssh ? 'ssh' : 'git'}${o.lease.helpersOff ? ':off' : ''}`);
    return p.includes('Username') ? 'octocat' : undefined;
  }, dir);
  await server.start();
  t.after(() => {
    server.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const run = (prompt, env, script = server.script) => new Promise((resolve) => {
    execFile(script, [prompt], { env: { ...process.env, ...env } }, (err, stdout) => resolve({ code: err ? err.code : 0, stdout }));
  });
  const lease = server.lease({ helpersOff: true });
  assert.deepEqual(await run("Username for 'https://github.com': ", lease.env), { code: 0, stdout: 'octocat\n' });
  assert.equal((await run('Password: ', lease.env)).code, 1, 'cancelled prompt exits 1');
  // A wrong token is rejected without asking the user.
  assert.equal((await run('Username: ', { ...lease.env, COMMIT_CORNER_ASKPASS_TOKEN: 'nope' })).code, 1);
  assert.equal(seen.length, 2);
  // Background git marks its prompts quiet (the callback must not show UI for them).
  await run("Username for 'https://github.com': ", { ...lease.env, COMMIT_CORNER_ASKPASS_QUIET: '1' });
  // ssh prompts arrive marked as such, even when they imitate git's (and a KIND in the
  // environment does not change that: the wrapper sets it).
  await run("Username for 'https://github.com': ", { ...lease.env, COMMIT_CORNER_ASKPASS_KIND: 'git' }, lease.env.SSH_ASKPASS);
  assert.deepEqual(flags, ['ui:git:off', 'ui:git:off', 'quiet:git:off', 'ui:ssh:off'], 'the lease\'s flag reaches the callback');
  // Once the command has exited, its token no longer works (a hook cannot keep it).
  lease.release();
  assert.equal((await run("Username for 'https://github.com': ", lease.env)).code, 1);
  assert.equal(seen.length, 4);
  assert.equal((fs.statSync(server.socketDir).mode & 0o777).toString(8), '700');
});

test('GitHub web links for commits and pull requests', () => {
  const { githubWebUrl, githubCommitUrl, githubPullUrl } = require('../src/git/remoteUrl');
  const base = githubWebUrl('git@github.com:o/r.git');
  assert.equal(githubCommitUrl(base, 'abc'), 'https://github.com/o/r/commit/abc');
  assert.equal(githubPullUrl(base, 7), 'https://github.com/o/r/pull/7');
});

test('compare URLs for "Create Pull Request" (same repository and forks)', () => {
  const { githubCompareUrl } = require('../src/git/remoteUrl');
  assert.equal(githubCompareUrl('https://github.com/o/r', 'main', 'feature/x'), 'https://github.com/o/r/compare/main...feature/x?expand=1');
  assert.equal(githubCompareUrl('https://github.com/org/r', 'release/2.0', 'fix#1', 'https://github.com/me/r'), 'https://github.com/org/r/compare/release/2.0...me:fix%231?expand=1');
  assert.equal(githubCompareUrl('https://github.com/o/r', 'main', 'x', 'https://github.com/o/r'), 'https://github.com/o/r/compare/main...x?expand=1');
});

test('SSH host aliases for github.com and the pull request a commit subject names', () => {
  const { githubWebUrl, setGithubHostAliases, pullRequestOfSubject } = require('../src/git/remoteUrl');
  assert.equal(githubWebUrl('git@github-work:org/repo.git'), undefined);
  setGithubHostAliases(['github-work', 'bad host', 42]);
  assert.equal(githubWebUrl('git@github-work:org/repo.git'), 'https://github.com/org/repo');
  setGithubHostAliases([]);
  assert.equal(pullRequestOfSubject('Fix the thing (#123)'), 123);
  assert.equal(pullRequestOfSubject('Merge pull request #7 from octo/feature'), 7);
  assert.equal(pullRequestOfSubject('Fix (#12) in the middle'), undefined);
});

test('paths from git compare with VS Code paths on Windows and macOS (case, separators, drive letter)', () => {
  const { normalizePath, samePath, isInside, isSameOrInside } = require('../src/git/pathUtil');
  assert.equal(normalizePath('C:/Users/me/repo', 'win32'), 'c:\\Users\\me\\repo');
  assert.equal(samePath('C:/Users/me/repo/.git', 'c:\\Users\\me\\repo\\.git', 'win32'), true);
  assert.equal(isInside('C:/Users/me/repo/.git', 'c:\\users\\me\\repo\\.git\\rebase-merge\\git-rebase-todo', 'win32'), true);
  assert.equal(isInside('c:\\work\\repo', 'c:\\work\\repo-other\\x', 'win32'), false, 'a sibling with the same prefix is not inside');
  assert.equal(isSameOrInside('/Users/Me/Repo', '/users/me/repo/src', 'darwin'), true);
  assert.equal(samePath('/home/me/Repo', '/home/me/repo', 'linux'), false, 'case matters on Linux');
});
