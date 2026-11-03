'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const fs = require('fs');
const { createRepo, makeTempDir } = require('./helpers/repo');
const { Repository, INDEX, WORKTREE } = require('../src/git/repository');
const { parseTodo } = require('../src/git/rebaseTodo');

async function setup(t) {
  const r = createRepo();
  t.after(() => r.cleanup());
  const repo = await Repository.open(r.dir);
  return { r, repo };
}

test('open() finds the repository root from a subdirectory and returns undefined outside', async (t) => {
  const { r } = await setup(t);
  r.write('sub/deep/file.txt', 'x');
  const repo = await Repository.open(path.join(r.dir, 'sub', 'deep'));
  assert.equal(repo.root, r.dir);
  assert.equal(repo.gitDir, path.join(r.dir, '.git'));
  const outside = makeTempDir();
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  assert.equal(await Repository.open(outside), undefined);
});

test('empty repository: state and log work without commits', async (t) => {
  const { r, repo } = await setup(t);
  r.write('a.txt', 'hello\n');
  const state = await repo.refreshState();
  assert.equal(state.head.sha, null);
  assert.equal(state.head.branch, 'main');
  assert.equal(state.untracked.length, 1);
  assert.deepEqual(await repo.log({ maxCount: 10 }), []);
  await repo.stage(['a.txt']);
  await repo.unstage(['a.txt']); // no HEAD: uses rm --cached
  assert.equal((await repo.refreshState()).untracked.length, 1);
});

test('status groups: staged, unstaged, untracked, renamed', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('init', { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
  r.write('a.txt', 'a2\n');
  r.git('add', 'a.txt');
  r.write('a.txt', 'a3\n');
  r.write('b.txt', 'b2\n');
  r.git('mv', 'c.txt', 'renamed.txt');
  r.write('new.txt', 'n\n');
  const s = await repo.refreshState();
  assert.deepEqual(s.staged.map((e) => e.path).sort(), ['a.txt', 'renamed.txt']);
  assert.equal(s.staged.find((e) => e.path === 'renamed.txt').origPath, 'c.txt');
  assert.deepEqual(s.unstaged.map((e) => e.path).sort(), ['a.txt', 'b.txt']);
  assert.deepEqual(s.untracked.map((e) => e.path), ['new.txt']);
});

test('show() reads HEAD, index, worktree and reports missing files as null', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('init', { 'f.txt': 'head\n' });
  r.write('f.txt', 'index\n');
  r.git('add', 'f.txt');
  r.write('f.txt', 'work\n');
  assert.equal(await repo.showText('HEAD', 'f.txt'), 'head\n');
  assert.equal(await repo.showText(INDEX, 'f.txt'), 'index\n');
  assert.equal(await repo.showText(WORKTREE, 'f.txt'), 'work\n');
  assert.equal(await repo.showText('HEAD', 'missing.txt'), null);
  assert.equal(await repo.showText('HEAD~5', 'f.txt'), null);
});

test('writeIndexContent stages arbitrary content, keeping the worktree', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('init', { 'f.txt': '1\n2\n3\n' });
  r.write('f.txt', '1\nTWO\n3\nFOUR\n');
  await repo.writeIndexContent('f.txt', '1\nTWO\n3\n');
  assert.equal(await repo.showText(INDEX, 'f.txt'), '1\nTWO\n3\n');
  assert.equal(r.read('f.txt'), '1\nTWO\n3\nFOUR\n');
  // new file, executable bit preserved
  r.write('run.sh', '#!/bin/sh\n');
  fs.chmodSync(path.join(r.dir, 'run.sh'), 0o755);
  await repo.writeIndexContent('run.sh', '#!/bin/sh\n');
  assert.equal(await repo.getIndexMode('run.sh'), '100755');
});

test('commit, amend, undo last commit', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('init', { 'f.txt': '1\n' });
  r.write('f.txt', '2\n');
  await repo.stage(['f.txt']);
  await repo.commit('second\n\nbody');
  let c = await repo.getCommit('HEAD');
  assert.equal(c.subject, 'second');
  assert.equal(c.body, 'second\n\nbody');
  await repo.commit('second (amended)', { amend: true });
  c = await repo.getCommit('HEAD');
  assert.equal(c.subject, 'second (amended)');
  const undone = await repo.undoLastCommit();
  assert.equal(undone.subject, 'second (amended)');
  const s = await repo.refreshState();
  assert.deepEqual(s.staged.map((e) => e.path), ['f.txt']);
  await assert.rejects(repo.commit('x', { amend: false, allowEmpty: false, all: false }).then(() => repo.commit('nothing')), (e) => e.code === 'NothingToCommit');
});

test('log with graph data, file history following renames, line history', async (t) => {
  const { r, repo } = await setup(t);
  const c1 = r.commit('add', { 'old.txt': 'a\nb\nc\n' });
  const c2 = r.commit('edit', { 'old.txt': 'a\nB\nc\n' });
  r.git('mv', 'old.txt', 'new.txt');
  const c3 = r.commit('rename');
  const c4 = r.commit('edit again', { 'new.txt': 'a\nB\nC\n' });
  const log = await repo.log({ topo: true });
  assert.deepEqual(log.map((c) => c.sha), [c4, c3, c2, c1]);
  assert.ok(log[0].refs.some((x) => x.type === 'branch' && x.name === 'main' && x.isHead));
  const hist = await repo.fileHistory('new.txt');
  assert.deepEqual(hist.map((c) => c.sha), [c4, c3, c2, c1]);
  assert.equal(hist[1].change.status, 'R');
  assert.equal(hist[1].change.origPath, 'old.txt');
  assert.equal(hist[2].change.path, 'old.txt');
  const lines = await repo.lineHistory('new.txt', 2, 2);
  assert.deepEqual(lines.map((c) => c.sha), [c2, c1]);
});

test('diffFiles two-dot, three-dot, against index and worktree', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'a.txt': '1\n', 'b.txt': '1\n' });
  r.git('checkout', '-q', '-b', 'feature');
  r.commit('feature', { 'a.txt': '2\n' });
  r.git('checkout', '-q', 'main');
  r.commit('main', { 'b.txt': '2\n' });
  const twoDot = await repo.diffFiles('main', 'feature');
  assert.deepEqual(twoDot.map((f) => f.path).sort(), ['a.txt', 'b.txt']);
  const threeDot = await repo.diffFiles('main', 'feature', { threeDot: true });
  assert.deepEqual(threeDot.map((f) => [f.path, f.added, f.deleted]), [['a.txt', 1, 1]]);
  r.write('a.txt', 'x\n');
  assert.deepEqual((await repo.diffFiles('HEAD')).map((f) => f.path), ['a.txt']);
  assert.deepEqual(await repo.diffFiles('HEAD', INDEX), []);
});

test('multi-commit changes over a non-contiguous selection', async (t) => {
  const { r, repo } = await setup(t);
  const c0 = r.commit('c0', { 'a.txt': '0\n', 'b.txt': '0\n' });
  const c1 = r.commit('c1', { 'a.txt': '1\n' });
  r.commit('c2', { 'b.txt': '2\n' });
  const c3 = r.commit('c3', { 'a.txt': '3\n', 'c.txt': 'new\n' });
  const { files, exact } = await repo.getMultiCommitChanges([c3, c1]);
  assert.equal(exact, true);
  const a = files.find((f) => f.path === 'a.txt');
  assert.equal(a.beforeRef, c0);
  assert.equal(await repo.showText(a.afterRef, 'a.txt'), '3\n');
  assert.equal(files.find((f) => f.path === 'c.txt').status, 'A');
  assert.equal(files.find((f) => f.path === 'b.txt'), undefined);
});

test('sortTopologically orders by ancestry, not by date', async (t) => {
  const { r, repo } = await setup(t);
  const a = r.commit('a');
  const b = r.commit('b');
  const c = r.commit('c');
  assert.deepEqual(await repo.sortTopologically([c, a, b]), [a, b, c]);
});

test('branches, refs, checkout, merge conflict detection and abort', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'f.txt': 'base\n' });
  await repo.createBranch('topic', undefined, true);
  r.commit('topic', { 'f.txt': 'topic\n' });
  await repo.checkout('main');
  r.commit('main', { 'f.txt': 'main\n' });
  const refs = await repo.getRefs();
  assert.deepEqual(refs.filter((x) => x.type === 'branch').map((x) => x.name).sort(), ['main', 'topic']);
  assert.deepEqual((await repo.predictConflicts('main', 'topic')).conflicts, ['f.txt']);
  await assert.rejects(repo.merge('topic'), (e) => e.code === 'Conflict');
  const s = await repo.refreshState();
  assert.equal(s.operation.kind, 'merge');
  assert.deepEqual(s.conflicts.map((c) => c.path), ['f.txt']);
  assert.equal(await repo.showText(':2', 'f.txt'), 'main\n');
  assert.equal(await repo.showText(':3', 'f.txt'), 'topic\n');
  await repo.abortOperation('merge');
  assert.equal((await repo.refreshState()).operation, undefined);
});

test('resolve conflict with theirs and continue merge', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'f.txt': 'base\n' });
  r.git('checkout', '-q', '-b', 'topic');
  r.commit('topic', { 'f.txt': 'topic\n' });
  r.git('checkout', '-q', 'main');
  r.commit('main', { 'f.txt': 'main\n' });
  await assert.rejects(repo.merge('topic'));
  await repo.resolveWith('f.txt', 'theirs');
  await repo.continueOperation('merge');
  assert.equal(r.read('f.txt'), 'topic\n');
  const head = await repo.getCommit('HEAD');
  assert.equal(head.parents.length, 2);
});

test('cherry-pick and revert multiple commits in the right order', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { 'f.txt': '' });
  r.git('checkout', '-q', '-b', 'src');
  const a = r.commit('a', { 'a.txt': 'a\n' });
  const b = r.commit('b', { 'b.txt': 'b\n' });
  r.git('checkout', '-q', 'main');
  await repo.cherryPick([b, a]);
  const log = await repo.log({ revs: ['HEAD'], maxCount: 2 });
  assert.deepEqual(log.map((c) => c.subject), ['b', 'a']);
  await repo.revert([log[0].sha, log[1].sha]);
  assert.ok(!fs.existsSync(path.join(r.dir, 'a.txt')));
});

test('interactive rebase: reorder, squash with new message, reword, drop', async (t) => {
  const { r, repo } = await setup(t);
  const base = r.commit('base', { 'f.txt': '' });
  const a = r.commit('a', { 'a.txt': 'a\n' });
  const b = r.commit('b', { 'b.txt': 'b\n' });
  const c = r.commit('c', { 'c.txt': 'c\n' });
  const d = r.commit('d', { 'd.txt': 'd\n' });
  const { entries } = parseTodo(`pick ${a} a\npick ${b} b\npick ${c} c\npick ${d} d\n`);
  // new order: c (reworded), a + squash b (new message), drop d
  const todo = [
    { ...entries[2], action: 'reword' },
    { ...entries[0] },
    { ...entries[1], action: 'squash' },
    { ...entries[3], action: 'drop' },
  ];
  await repo.rebaseInteractive(base, todo, new Map([[0, 'C reworded'], [2, 'A and B']]));
  const log = await repo.log({ revs: ['HEAD'], body: true });
  assert.deepEqual(log.map((x) => x.subject), ['A and B', 'C reworded', 'base']);
  assert.ok(!fs.existsSync(path.join(r.dir, 'd.txt')));
  assert.equal((await repo.refreshState()).operation, undefined);
});

test('stash push/list/files/apply/drop including untracked', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('init', { 'f.txt': '1\n' });
  r.write('f.txt', '2\n');
  r.write('u.txt', 'u\n');
  await repo.stashPush({ message: 'wip', includeUntracked: true });
  const [s] = await repo.getStashes();
  assert.equal(s.description, 'wip');
  const files = await repo.getStashFiles(s);
  assert.deepEqual(files.map((f) => [f.path, f.status]).sort(), [['f.txt', 'M'], ['u.txt', 'U']]);
  assert.equal(r.read('f.txt'), '1\n');
  await repo.stashApply(s.ref, false);
  assert.equal(r.read('f.txt'), '2\n');
  await repo.stashDrop(s.ref);
  assert.equal((await repo.getStashes()).length, 0);
});

test('worktrees: add, list, remove', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('init', { 'f.txt': '1\n' });
  const wtDir = path.join(makeTempDir(), 'wt');
  t.after(() => fs.rmSync(path.dirname(wtDir), { recursive: true, force: true }));
  await repo.addWorktree(wtDir, { newBranch: 'wt-branch' });
  const list = await repo.getWorktrees();
  assert.equal(list.length, 2);
  assert.equal(list[1].branch, 'wt-branch');
  const linked = await Repository.open(wtDir);
  assert.notEqual(linked.gitDir, linked.commonDir);
  await repo.removeWorktree(wtDir);
  assert.equal((await repo.getWorktrees()).length, 1);
});

test('pull requests: list, fetch, and resolve base like GitHub', async (t) => {
  // A local bare "GitHub" remote that publishes refs/pull/*.
  const { r, repo } = await setup(t);
  r.commit('base', { 'f.txt': '1\n' });
  const remoteDir = makeTempDir('cc-remote-');
  t.after(() => fs.rmSync(remoteDir, { recursive: true, force: true }));
  r.git('init', '-q', '--bare', remoteDir);
  r.git('remote', 'add', 'origin', remoteDir);
  r.git('push', '-q', 'origin', 'main');
  r.git('fetch', '-q', 'origin');
  r.git('remote', 'set-head', 'origin', 'main');
  r.git('checkout', '-q', '-b', 'pr-branch');
  const prHead = r.commit('pr work', { 'g.txt': 'g\n' });
  r.git('push', '-q', 'origin', `${prHead}:refs/pull/7/head`);
  r.git('checkout', '-q', 'main');
  r.commit('main moves on', { 'f.txt': '2\n' });
  r.git('push', '-q', 'origin', 'main');
  r.git('fetch', '-q', 'origin');

  const prs = await repo.listPullRequests('origin');
  assert.deepEqual(prs.map((p) => p.number), [7]);
  const sha = await repo.fetchPullRequest('origin', 7, { withMerge: true });
  assert.equal(sha, prHead);
  const fetched = await repo.getFetchedPullRequests('origin');
  assert.equal(fetched.get(7).subject, 'pr work');
  const { baseRef, mergeBase } = await repo.resolvePullRequestBase('origin', 7, sha);
  assert.equal(baseRef, 'origin/main');
  const files = await repo.diffFiles(mergeBase, sha);
  assert.deepEqual(files.map((f) => f.path), ['g.txt']);

  // After a real merge, the PR diff still shows the PR's own changes.
  r.git('merge', '-q', '--no-ff', '-m', 'Merge PR 7', prHead);
  r.git('push', '-q', 'origin', 'main');
  r.git('fetch', '-q', 'origin');
  const after = await repo.resolvePullRequestBase('origin', 7, sha, 'origin/main');
  assert.equal(after.merged, true);
  assert.deepEqual((await repo.diffFiles(after.mergeBase, sha)).map((f) => f.path), ['g.txt']);
});

test('blame of unsaved contents marks new lines as uncommitted', async (t) => {
  const { r, repo } = await setup(t);
  const c = r.commit('init', { 'f.txt': 'a\nb\n' });
  const b = await repo.blame('f.txt', 'a\nnew\nb\n');
  assert.equal(b.lines.length, 3);
  assert.equal(b.lines[0], c);
  assert.ok(b.commits.get(b.lines[1]).uncommitted);
  assert.equal(b.lines[2], c);
});

test('ignore() appends to .gitignore once', async (t) => {
  const { r, repo } = await setup(t);
  await repo.ignore('build/');
  await repo.ignore('build/');
  assert.equal(r.read('.gitignore'), 'build/\n');
});

test('reflog and tags', async (t) => {
  const { r, repo } = await setup(t);
  const c = r.commit('init', { 'f.txt': '1\n' });
  await repo.createTag('v1', c, 'release one');
  await repo.createTag('light', c);
  const tags = (await repo.getRefs()).filter((x) => x.type === 'tag');
  assert.deepEqual(tags.map((x) => [x.name, x.sha]).sort(), [['light', c], ['v1', c]]);
  const reflog = await repo.reflog();
  assert.ok(reflog.length >= 1);
  await repo.deleteTag('v1');
  assert.equal((await repo.getRefs()).filter((x) => x.type === 'tag').length, 1);
});

/** A merge that resolves a conflict (f), edits a file nobody changed (g, an "evil" merge),
 * merges a file both sides changed apart (h) and keeps a file one side deleted (d). */
function mergeScenario(r) {
  r.commit('base', { f: 'a\nb\nc\n', g: 'x\n', h: '1\n2\n3\n4\n5\n6\n7\n', d: 'del\n' });
  r.git('switch', '-q', '-c', 'side');
  r.commit('side 1', { f: 'a\nB2\nc\n', h: '1\n2x\n3\n4\n5\n6\n7\n', d: 'mod\n' });
  r.commit('side 2', { s: 'side\n' });
  r.git('switch', '-q', 'main');
  r.commit('main 1', { f: 'a\nB1\nc\n', g: 'x\ny\n', h: '1\n2\n3\n4\n5\n6x\n7\n', d: null });
  try { r.git('merge', '-q', '--no-ff', 'side', '-m', 'merge side'); } catch { /* conflicts */ }
  return r.commit('merge side', { f: 'a\nRESOLVED\nc\n', g: 'x\ny\nevil\n', h: '1\n2x\n3\n4\n5\n6x\n7\n', d: 'mod\n', s: 'side\n' });
}

for (const [name, how] of [['merge-tree --write-tree (git >= 2.38)', 'mergeTree'], ['the resolve fallback (git < 2.38)', 'resolveMergeTree']]) {
  test(`merge resolution with ${name}: only the resolved conflict and the extra edit`, async (t) => {
    const { getVersion, versionAtLeast } = require('../src/git/exec');
    if (how === 'mergeTree' && !versionAtLeast(await getVersion(), 2, 38)) return t.skip('needs git 2.38');
    const { r, repo } = await setup(t);
    const m = mergeScenario(r);
    const [p1, p2] = r.git('log', '-1', '--format=%P', m).split(' ');
    const tmp = makeTempDir('cc-remerge-');
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    repo.tempRoot = tmp;
    const merged = await repo[how](p1, p2);
    assert.match(merged.tree, /^[0-9a-f]{40}$/);
    assert.deepEqual(merged.conflicts.sort(), ['d', 'f']);
    assert.equal(merged.exact, how === 'mergeTree');
    // git's own merge: the conflict with markers, the clean three-way merge, the changed side of d.
    const f = await repo.showText(merged.tree, 'f');
    assert.match(f, new RegExp(`^a\\n<<<<<<< ${p1}\\nB1\\n=======\\nB2\\n>>>>>>> ${p2}\\nc\\n$`));
    assert.equal(await repo.showText(merged.tree, 'h'), '1\n2x\n3\n4\n5\n6x\n7\n');
    assert.equal(await repo.showText(merged.tree, 'd'), 'mod\n');
    const files = await repo.diffFiles(merged.tree, m);
    assert.deepEqual(files.map((x) => `${x.status} ${x.path}`), ['M f', 'M g']);
    // Nothing of the real index or working tree changed; no temporary files are left; its objects
    // are the repository's own (git sees them too), and the repository is sound.
    assert.equal(r.git('status', '--porcelain'), '');
    assert.deepEqual(fs.readdirSync(tmp), []);
    assert.deepEqual(fs.readdirSync(path.join(r.dir, '.git')).filter((x) => x.startsWith('commit-corner-')), []);
    r.git('cat-file', '-e', merged.tree);
    r.git('fsck', '--no-dangling');
  });
}

test('getMergeResolution: files with blobs, remembered; a clean merge has none; not for octopus or plain commits', async (t) => {
  const { r, repo } = await setup(t);
  const m = mergeScenario(r);
  const res = await repo.getMergeResolution(m);
  assert.deepEqual(res.files.map((x) => x.path), ['f', 'g']);
  assert.ok(res.files.every((x) => /^[0-9a-f]{40}$/.test(x.oldBlob) && /^[0-9a-f]{40}$/.test(x.newBlob)));
  assert.equal(res.parents.length, 2);
  assert.equal(await repo.getMergeResolution(m), res);
  assert.equal(await repo.countChanges(res.tree, m), 2);
  assert.equal(await repo.countChanges(res.parents[0], m), 5); // what the merge brought into main: d, f, g, h, s
  r.git('switch', '-q', '-c', 'clean', 'main~1');
  r.git('switch', '-q', '-c', 'other', 'main~1');
  r.commit('other', { o: 'o\n' });
  r.git('switch', '-q', 'clean');
  r.commit('clean side', { c: 'c\n' });
  r.git('merge', '-q', '--no-ff', 'other', '-m', 'clean merge');
  assert.deepEqual((await repo.getMergeResolution('HEAD')).files, []);
  await assert.rejects(repo.getMergeResolution('HEAD~1'), /not a merge commit/);
  r.git('switch', '-q', '-c', 'o1', 'HEAD~1');
  r.commit('o1', { o1: '1\n' });
  r.git('switch', '-q', '-c', 'o2', 'clean~1');
  r.commit('o2', { o2: '2\n' });
  r.git('merge', '-q', 'o1', 'other', '-m', 'octopus');
  await assert.rejects(repo.getMergeResolution('HEAD'), /merges 3 parents/);
});

test('getMergeResolution of a merge of unrelated histories', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { a: 'a\n' });
  r.git('switch', '-q', '--orphan', 'other');
  r.git('rm', '-rqf', '--ignore-unmatch', '.');
  r.commit('other', { o: 'o\n' });
  r.git('switch', '-q', 'main');
  r.git('merge', '-q', '--allow-unrelated-histories', 'other', '-m', 'join');
  assert.deepEqual((await repo.getMergeResolution('HEAD')).files, []);
  assert.deepEqual((await repo.resolveMergeTree('HEAD^1', 'HEAD^2')).conflicts, []);
});

/** Two sides from one base, merged with "merge side" as given (files: path -> content; null deletes). */
function twoSides(r, base, main, side, result) {
  r.commit('base', base);
  r.git('switch', '-q', '-c', 'side');
  r.commit('side', side);
  r.git('switch', '-q', 'main');
  r.commit('main', main);
  try { r.git('merge', '-q', '--no-ff', '--no-commit', 'side'); } catch { /* conflicts */ }
  return r.commit('merge side', result);
}

test('resolve fallback: a binary conflict keeps the first parent, add/add merges with markers, both-sides edits merge', async (t) => {
  const { r, repo } = await setup(t);
  const m = twoSides(r,
    { bin: 'a\0base', text: '1\n2\n3\n' },
    { bin: 'a\0main', text: '1\n2\n3m\n', added: 'main\n' },
    { bin: 'a\0side', text: '1s\n2\n3\n', added: 'side\n' },
    { bin: 'a\0main', text: '1s\n2\n3m\n', added: 'main\n' });
  const [p1, p2] = r.git('log', '-1', '--format=%P', m).split(' ');
  const merged = await repo.resolveMergeTree(p1, p2);
  assert.deepEqual(merged.conflicts.sort(), ['added', 'bin']);
  assert.equal(await repo.showText(merged.tree, 'bin'), 'a\0main');
  assert.match(await repo.showText(merged.tree, 'added'), new RegExp(`^<<<<<<< ${p1}\\nmain\\n=======\\nside\\n>>>>>>> ${p2}\\n$`));
  assert.equal(await repo.showText(merged.tree, 'text'), '1s\n2\n3m\n');
  // What the merge commit itself changed: only the add/add file it resolved.
  assert.deepEqual((await repo.diffFiles(merged.tree, m)).map((x) => x.path), ['added']);
});

test('resolve fallback: symlinks changed on both sides keep the first parent\'s link', { skip: process.platform === 'win32' }, async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { keep: 'k\n' });
  const link = (target, msg) => {
    fs.rmSync(path.join(r.dir, 'ln'), { force: true });
    fs.symlinkSync(target, path.join(r.dir, 'ln'));
    return r.commit(msg);
  };
  link('base', 'link');
  r.git('switch', '-q', '-c', 'side');
  const p2 = link('side', 'side link');
  r.git('switch', '-q', 'main');
  const p1 = link('main', 'main link');
  const merged = await repo.resolveMergeTree(p1, p2);
  assert.deepEqual(merged.conflicts, ['ln']);
  assert.match((await repo.exec(['ls-tree', merged.tree, 'ln'])).stdout, /^120000 /);
  assert.equal(await repo.showText(merged.tree, 'ln'), 'main');
});

test('resolve fallback: a mode change on one side and an edit on the other keep both', async (t) => {
  const { r, repo } = await setup(t);
  r.commit('base', { run: '1\n2\n3\n' });
  r.git('switch', '-q', '-c', 'side');
  fs.chmodSync(path.join(r.dir, 'run'), 0o755);
  r.git('update-index', '--chmod=+x', 'run');
  r.git('commit', '-q', '-m', 'exec');
  r.git('switch', '-q', 'main');
  const p1 = r.commit('edit', { run: '1\n2\n3 edited\n' });
  const p2 = r.git('rev-parse', 'side');
  const merged = await repo.resolveMergeTree(p1, p2);
  assert.deepEqual(merged.conflicts, []);
  const entry = (await repo.exec(['ls-tree', merged.tree, 'run'])).stdout.trim();
  assert.match(entry, /^100755 blob /);
  assert.equal(await repo.showText(merged.tree, 'run'), '1\n2\n3 edited\n');
});

test('resolve fallback: over 1000 files changed on both sides is an error, not a partial answer', async (t) => {
  const { r, repo } = await setup(t);
  const files = (v) => Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`d/${i}`, `${v}\n`]));
  r.commit('base', files('base'));
  r.git('switch', '-q', '-c', 'side');
  const p2 = r.commit('side', files('side'));
  r.git('switch', '-q', 'main');
  const p1 = r.commit('main', files('main'));
  const tmp = makeTempDir('cc-remerge-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  repo.tempRoot = tmp;
  await assert.rejects(repo.resolveMergeTree(p1, p2), /1001 files changed on both sides, too many/);
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test('getMergeResolution: one run for callers at the same time; one giving up does not stop it for the other; all giving up stops it', async (t) => {
  const { r, repo } = await setup(t);
  const m = mergeScenario(r);
  let runs = 0;
  const real = repo.diffFiles.bind(repo);
  repo.diffFiles = (...a) => {
    runs++;
    return real(...a);
  };
  const quitter = new AbortController();
  const a = repo.getMergeResolution(m, { signal: quitter.signal });
  const b = repo.getMergeResolution(m);
  quitter.abort();
  await assert.rejects(a, (e) => e.code === 'Cancelled');
  const res = await b;
  assert.deepEqual(res.files.map((x) => x.path), ['f', 'g']);
  assert.equal(runs, 1);
  assert.equal(repo.knownMergeResolution(r.git('rev-parse', m)), res);
  // A fresh commit's run, everyone gone: stopped, nothing kept, no temporary files.
  r.git('switch', '-q', '-c', 'again', `${m}^1`);
  r.git('merge', '-q', '--no-ff', '-s', 'ours', `${m}^2`, '-m', 'again');
  const tmp = makeTempDir('cc-remerge-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  repo.tempRoot = tmp;
  const all = new AbortController();
  const c = repo.getMergeResolution('HEAD', { signal: all.signal });
  setTimeout(() => all.abort(), 5); // (in the middle of it, wherever that is)
  await c.then(() => {}, (e) => assert.equal(e.code, 'Cancelled'));
  await new Promise((res) => setTimeout(res, 300));
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test('getMergeResolution in a shallow clone without the merge base says so', async (t) => {
  const { r } = await setup(t);
  mergeScenario(r);
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  r.git('clone', '-q', '--depth', '2', `file://${r.dir}`, dir); // the merge and its parents, not their base
  const shallow = await Repository.open(dir);
  await assert.rejects(shallow.getMergeResolution('HEAD'), /shallow/);
});

test('after viewing a merge resolution, the same merge made again (or fetched) keeps every object in the repository', async (t) => {
  // A merge with an extra edit, whose automatic merge this clone never made (so git's merge
  // result exists only once Merge Resolution made it): then merged again here.
  const { r } = await setup(t);
  const m = twoSides(r, { f: '1\n2\n3\n' }, { f: '1m\n2\n3\n' }, { f: '1\n2\n3s\n' }, { f: '1m\n2\n3s\nextra\n' });
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  r.git('clone', '-q', '--no-local', r.dir, dir);
  const repo = await Repository.open(dir);
  const res = await repo.getMergeResolution(m);
  assert.deepEqual(res.files.map((x) => x.path), ['f']);
  const run = (...a) => repo.exec(a, { writes: true });
  await run('reset', '-q', '--hard', `${m}^1`);
  await run('-c', 'user.name=T', '-c', 'user.email=t@x', 'merge', '-q', '--no-ff', '--no-edit', `${m}^2`);
  // Plain git (no environment of ours) finds everything the new merge needs.
  execFileSync('git', ['fsck', '--no-dangling'], { cwd: dir });
  execFileSync('git', ['show', 'HEAD:f'], { cwd: dir });
});

test('resolve fallback: a conflict style git does not know (zdiff3 before 2.35) does not stop it', async (t) => {
  const { r, repo } = await setup(t);
  const m = mergeScenario(r);
  r.git('config', 'merge.conflictStyle', 'zdiff3');
  const [p1, p2] = r.git('log', '-1', '--format=%P', m).split(' ');
  const merged = await repo.resolveMergeTree(p1, p2);
  assert.deepEqual(merged.conflicts.sort(), ['d', 'f']);
  // diff3 markers (zdiff3 where git has it): the base section is there.
  assert.match(await repo.showText(merged.tree, 'f'), /^\|\|\|\|\|\|\| /m);
});

test('resolve fallback: a partial clone (a promisor remote of any name) is refused, not fetched file by file', async (t) => {
  const { r, repo } = await setup(t);
  const m = mergeScenario(r);
  r.git('config', 'remote.upstream.url', 'https://example.invalid/x.git');
  r.git('config', 'remote.upstream.promisor', 'yes');
  const [p1, p2] = r.git('log', '-1', '--format=%P', m).split(' ');
  await assert.rejects(repo.resolveMergeTree(p1, p2), /partial clone/);
});
