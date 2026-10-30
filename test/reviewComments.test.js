'use strict';

/**
 * Review comments for an agent: comments on lines of its work, kept per worktree, that follow
 * their lines when the file changes, and go back to the agent as one text (or a file).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRepo } = require('./helpers/repo');
const { createVscode, installVscodeMock } = require('./helpers/vscodeMock');

const mock = createVscode();
installVscodeMock(mock);

const { Repository } = require('../src/git/repository');
const F = require('../src/vscode/review/format');
const { execFileSync } = require('child_process');

/** git in another folder (a worktree), as its tests' user. */
const gitIn = (dir, ...args) => execFileSync('git', ['-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', ...args], { cwd: dir, encoding: 'utf8' }).trim();

function memento() {
  const data = new Map();
  return { get: (k) => data.get(k), update: async (k, v) => (v === undefined ? data.delete(k) : data.set(k, v)), data };
}

/** Where a comment on lines start..end of `lines` is found again in `now`. */
const find = (lines, start, end, now) => F.relocate(F.normLines(now), start, F.anchorOf(lines, start, end));

// ------------------------------------------------------------------ text and lines

test('a comment follows its lines: same place, moved by lines added above, reindented, or changed', () => {
  const lines = ['a', 'b', '  if (x) {', '    run();', '  }', 'z'];
  assert.equal(find(lines, 2, 3, lines), 2);
  assert.equal(find(lines, 2, 3, ['new', 'new 2', ...lines]), 4, 'two lines added above');
  assert.equal(find(lines, 2, 3, ['a', 'b', 'if (x) {', 'run();', '}', 'z']), 2, 'reindented: still the same lines');
  assert.equal(find(lines, 2, 3, ['a', 'b', '  if (y) {', '    run();', '  }']), undefined, 'the lines themselves changed');
});

test('a "}" or a blank line is found again by its neighbours, not at the nearest "}"', () => {
  const lines = ['function a() {', '  one();', '}', '', 'function b() {', '  two();', '}', ''];
  // The comment is on b's closing brace (line 7); three lines are added at the top.
  const now = ['// 1', '// 2', '// 3', ...lines];
  assert.equal(find(lines, 6, 6, now), 9);
  // A blank line between the two functions, then lines added above.
  assert.equal(find(lines, 3, 3, ['x', ...lines]), 4);
  // Same lines above and below at the same distance: below first (insertions push lines down).
  assert.equal(F.relocate(F.normLines(['}', 'x', '}']), 1, { anchor: ['}'] }), 2);
});

test('relocating many comments in a big file stays fast', () => {
  const lines = Array.from({ length: 200000 }, (_, k) => (k % 7 ? `line ${k}` : '}'));
  const now = ['added', ...lines];
  const normed = F.normLines(now);
  const t0 = Date.now();
  for (let k = 0; k < 50; k++) F.relocate(normed, 1000 + k * 3000, F.anchorOf(lines, 1000 + k * 3000, 1001 + k * 3000));
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
});

test('the review for the agent: what to do, then each comment quoted with its file, lines and code', () => {
  const text = F.reviewText({
    name: 'agent-1',
    branch: 'feature/login',
    threads: [
      { path: 'src/b.js', ref: null, start: 9, end: 9, code: ['return x;'], comments: ['Handle the empty case.', 'And log it.'] },
      { path: 'src/a.js', ref: 'a'.repeat(40), start: 0, end: 1, code: ['const s = `x`;', '```'], comments: ['Use a constant.\n```\nnot closed'] },
      { path: 'gone.js', ref: null, start: 4, end: 4, state: 'changed', code: ['old line'], comments: ['# Rename this.'] },
      { path: 'lost.js', ref: null, start: 1, end: 1, state: 'missing', code: ['x'], comments: ['Bring it back?'] },
    ],
  });
  assert.match(text, /^# Review comments for branch `feature\/login` \(agent-1\)\n/);
  assert.match(text, /Please address these 4 review comments\./);
  const order = ['gone.js', 'lost.js', 'src/a.js', 'src/b.js'].map((p) => text.indexOf(`\`${p}\``));
  assert.deepEqual([...order].sort((x, y) => x - y), order, 'sorted by file');
  assert.match(text, /`src\/b\.js`, line 10\n\n```js\n10  return x;\n```\n\n> Handle the empty case\.\n\n> And log it\./);
  // Code with ``` in it: a longer fence. A comment's open fence or "#" stays inside its quote.
  assert.match(text, /````js\n1  const s = `x`;\n2  ```\n````/);
  assert.match(text, /> Use a constant\.\n> ```\n> not closed/);
  assert.match(text, /> # Rename this\./);
  // Old code without today's line numbers.
  assert.match(text, /`gone\.js`, line 5 \(these lines have changed since the comment; they were:\)\n\n```js\nold line\n```/);
  assert.match(text, /`lost\.js`, line 2 \(the file is not there any more; the lines were:\)/);
});

test('repository text cannot break the review apart', () => {
  const text = F.reviewText({ name: 'w\n## 9. fake', threads: [{ path: 'a\n\n## 2. `x`', ref: null, start: 0, end: 0, code: ['y'.repeat(5000)], comments: ['c'] }] });
  assert.doesNotMatch(text, /\n## 9\. fake/);
  assert.doesNotMatch(text, /\n## 2\./);
  assert.match(text, /a\\n\\n## 2\./);
  assert.ok(text.length < 1500, 'a long line is cut');
});

// ------------------------------------------------------------------ the whole thing

async function setup(t) {
  const r = createRepo();
  t.after(() => r.cleanup());
  const repo = await Repository.open(r.dir);
  t.after(() => repo.dispose());
  await repo.refreshState();
  const cmds = {};
  const subs = [];
  const opened = new mock.vscode.EventEmitter();
  let ready;
  const manager = {
    repositories: [repo],
    ready: new Promise((res) => (ready = res)),
    onDidOpen: opened.event,
    getRepository: (root) => (root === repo.root ? repo : undefined),
    getRepositoryForUri: (uri) => (uri.fsPath === repo.root || uri.fsPath.startsWith(repo.root + path.sep) ? repo : undefined),
  };
  const review = require('../src/vscode/review');
  const memo = memento();
  review.register({ manager, command: (id, fn) => (cmds[id] = fn), extContext: { workspaceState: memo, subscriptions: subs } });
  ready();
  t.after(() => subs.forEach((d) => d.dispose && d.dispose()));
  const controller = mock.commentControllers[mock.commentControllers.length - 1];
  /** An open editor's document for a file (its text from disk). */
  const open = (uri) => {
    const doc = { uri, getText: () => fs.readFileSync(uri.fsPath, 'utf8'), get lineCount() { return this.getText().split('\n').length; } };
    mock.vscode.workspace.textDocuments.push(doc);
    t.after(() => {
      const i = mock.vscode.workspace.textDocuments.indexOf(doc);
      if (i >= 0) mock.vscode.workspace.textDocuments.splice(i, 1);
    });
    return doc;
  };
  const clip = () => mock.vscode.env.clipboard.text;
  return { r, repo, cmds, controller, open, store: review.get(), memo, manager, clip };
}

/** An agent's worktree beside the repository, on branch agent/login. */
function agentWorktree(t, r) {
  const wt = path.join(path.dirname(r.dir), `${path.basename(r.dir)}-agent`);
  r.git('worktree', 'add', '-q', '-b', 'agent/login', wt);
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));
  return fs.realpathSync(wt);
}

test('comment on a line of an agent\'s worktree: it moves with edits, the review points at it, Save writes it there', async (t) => {
  const { r, repo, cmds, controller, open, store, clip } = await setup(t);
  r.commit('base', { 'app.js': 'one\ntwo\nfunction load(items) {\n  return items[0];\n}\n' });
  const wt = agentWorktree(t, r);
  const file = mock.vscode.Uri.file(path.join(wt, 'app.js'));
  const doc = open(file);
  // The + on line 4 ("return items[0];"), then Add Comment.
  const thread = controller.newThread(file, new mock.vscode.Range(3, 0, 3, 0));
  await cmds['commitCorner.review.add']({ thread, text: '  Handle an empty list.  ' });
  const [saved] = store.forRoot(wt);
  assert.ok(saved, 'kept under the agent\'s worktree');
  assert.deepEqual([saved.path, saved.anchor, saved.before, saved.after], ['app.js', ['  return items[0];'], 'function load(items) {', '}']);
  assert.equal(thread.comments[0].body.value, 'Handle an empty list.');
  assert.equal(thread.label, 'For the agent');
  await cmds['commitCorner.review.reply']({ thread, text: 'With a test.' });
  // Typed in the editor: two lines above it. The thread moves with them (as VS Code reports the edit).
  fs.writeFileSync(file.fsPath, '// header\n// more\none\ntwo\nfunction load(items) {\n  return items[0];\n}\n');
  mock.events.onDidChangeTextDocument.fire({ document: doc, contentChanges: [{ range: new mock.vscode.Range(0, 0, 0, 0), text: '// header\n// more\n' }] });
  assert.equal(thread.range.start.line, 5);
  assert.equal(store.forRoot(wt)[0].start, 5);
  await cmds['commitCorner.review.copy']({ worktreePath: wt });
  assert.match(clip(), /# Review comments for branch `agent\/login`/);
  assert.match(clip(), /`app\.js`, line 6\n\n```js\n6 {4}return items\[0\];\n```\n\n> Handle an empty list\.\n\n> With a test\./);
  // Save: the file in the worktree, which git ignores (in the repository's own info/exclude).
  await cmds['commitCorner.review.save']({ worktreePath: wt });
  assert.equal(fs.readFileSync(path.join(wt, '.review-comments.md'), 'utf8'), clip());
  assert.doesNotMatch(gitIn(wt, 'status', '--porcelain', '--untracked-files=all'), /review-comments/, 'git does not see it');
  assert.match(fs.readFileSync(path.join(repo.commonDir, 'info', 'exclude'), 'utf8'), /^\/\.review-comments\.md$/m);
  // An edit on the line itself: the comment says the lines changed.
  fs.writeFileSync(file.fsPath, '// header\n// more\none\ntwo\nfunction load(items) {\n  return items.length ? items[0] : null;\n}\n');
  mock.events.onDidChangeTextDocument.fire({ document: doc, contentChanges: [{ range: new mock.vscode.Range(5, 9, 5, 17), text: 'items.length ? items[0] : null' }] });
  assert.match(thread.label, /these lines have changed/);
  await cmds['commitCorner.review.copy']({ worktreePath: wt });
  assert.match(clip(), /line 6 \(these lines have changed since the comment; they were:\)\n\n```js\n {2}return items\[0\];\n```/);
  // Delete All (asked first).
  mock.ui.answers.push('Delete');
  await cmds['commitCorner.review.clear']({ worktreePath: wt });
  assert.equal(store.forRoot(wt).length, 0);
  assert.ok(thread.disposed, 'its thread goes from the editor');
});

test('a comment on an agent\'s commit goes to that agent\'s review, and its row opens the commit there', async (t) => {
  const { r, repo, cmds, controller, store, clip } = await setup(t);
  r.commit('base', { 'a.txt': 'x\n' });
  const wt = agentWorktree(t, r);
  fs.writeFileSync(path.join(wt, 'agent.txt'), 'the agent was here\n');
  gitIn(wt, 'add', 'agent.txt');
  gitIn(wt, 'commit', '-q', '-m', 'Agent work');
  const sha = gitIn(wt, 'rev-parse', 'HEAD');
  const { toGitUri } = require('../src/vscode/uri');
  // As the graph opens it: the repository's URI for that commit.
  const rev = toGitUri(repo.root, 'agent.txt', sha, { commit: sha });
  const ranges = await controller.commentingRangeProvider.provideCommentingRanges({ uri: rev, lineCount: 1, getText: () => 'the agent was here\n' });
  assert.equal(ranges.length, 1);
  const thread = controller.newThread(rev, new mock.vscode.Range(0, 0, 0, 0));
  await cmds['commitCorner.review.add']({ thread, text: 'Why here?' });
  assert.equal(store.forRoot(wt).length, 1, 'under the agent\'s worktree');
  assert.equal(store.forRoot(repo.root).length, 0);
  await cmds['commitCorner.review.copy']({ worktreePath: wt });
  assert.match(clip(), new RegExp(`\`agent\\.txt\`, line 1 in commit ${sha.slice(0, 7)}\\n\\n\`\`\`txt\\n1  the agent was here\\n\`\`\`\\n\\n> Why here\\?`));
  // Its row in the Worktrees view opens that revision.
  const shown = [];
  const saved = mock.vscode.window.showTextDocument;
  mock.vscode.window.showTextDocument = async (uri) => shown.push(uri);
  t.after(() => (mock.vscode.window.showTextDocument = saved));
  await cmds['commitCorner.review.open']({ reviewThread: store.forRoot(wt)[0].id });
  assert.equal(JSON.parse(shown[0].query).ref, sha);
  // The index and refs that move take no comments; neither do files outside every repository.
  const doc = (uri) => ({ uri, lineCount: 1, getText: () => '' });
  for (const uri of [toGitUri(repo.root, 'a.txt', ':'), toGitUri(repo.root, 'a.txt', 'HEAD'), mock.vscode.Uri.file('/elsewhere/x.txt')]) {
    assert.equal((await controller.commentingRangeProvider.provideCommentingRanges(doc(uri))).length, 0, String(uri));
  }
});

test('comments come back in editors that were open before the repositories were known', async (t) => {
  const r = createRepo();
  t.after(() => r.cleanup());
  r.commit('base', { 'f.txt': 'a\nb\nc\n' });
  const repo = await Repository.open(r.dir);
  t.after(() => repo.dispose());
  const file = mock.vscode.Uri.file(path.join(repo.root, 'f.txt'));
  const memo = memento();
  memo.data.set('reviewComments', [{ id: 'x', root: repo.root, repoRoot: repo.root, path: 'f.txt', ref: null, start: 1, end: 1, anchor: ['b'], before: 'a', after: 'c', comments: [{ id: 'c', body: 'b?', time: 1 }], time: 1 }]);
  const doc = { uri: file, getText: () => 'a\nb\nc\n', lineCount: 4 };
  mock.vscode.workspace.textDocuments.push(doc);
  t.after(() => mock.vscode.workspace.textDocuments.splice(mock.vscode.workspace.textDocuments.indexOf(doc), 1));
  const opened = new mock.vscode.EventEmitter();
  const manager = { repositories: [], ready: Promise.resolve(), onDidOpen: opened.event, getRepository: () => undefined, getRepositoryForUri: () => undefined };
  const subs = [];
  require('../src/vscode/review').register({ manager, command: () => {}, extContext: { workspaceState: memo, subscriptions: subs } });
  t.after(() => subs.forEach((d) => d.dispose && d.dispose()));
  const controller = mock.commentControllers[mock.commentControllers.length - 1];
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(controller.threads.length, 0, 'not yet: no repository');
  manager.repositories.push(repo);
  manager.getRepository = () => repo;
  manager.getRepositoryForUri = () => repo;
  opened.fire(repo);
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(controller.threads.length, 1);
  assert.equal(controller.threads[0].range.start.line, 1);
});

test('editing and deleting comments; an empty comment is not added', async (t) => {
  const { r, repo, cmds, controller, open, store } = await setup(t);
  r.commit('base', { 'f.txt': 'a\nb\n' });
  const file = mock.vscode.Uri.file(path.join(repo.root, 'f.txt'));
  open(file);
  const thread = controller.newThread(file, new mock.vscode.Range(0, 0, 0, 0));
  await cmds['commitCorner.review.add']({ thread, text: '   ' });
  assert.equal(store.forRoot(repo.root).length, 0);
  await cmds['commitCorner.review.add']({ thread, text: 'first' });
  await cmds['commitCorner.review.reply']({ thread, text: 'second' });
  const [c1, c2] = thread.comments;
  await cmds['commitCorner.review.editComment'](c1);
  assert.equal(c1.mode, mock.vscode.CommentMode.Editing);
  c1.body = 'first, **edited**';
  await cmds['commitCorner.review.saveComment'](c1);
  assert.equal(store.forRoot(repo.root)[0].comments[0].body, 'first, **edited**');
  assert.equal(c1.body.value, 'first, **edited**', 'shown as Markdown');
  await cmds['commitCorner.review.editComment'](c2);
  c2.body = 'not saved';
  await cmds['commitCorner.review.cancelEdit'](c2);
  assert.equal(c2.body.value, 'second');
  await cmds['commitCorner.review.deleteComment'](c2);
  assert.equal(store.forRoot(repo.root)[0].comments.length, 1);
  await cmds['commitCorner.review.deleteComment'](thread.comments[0]);
  assert.equal(store.forRoot(repo.root).length, 0, 'the last comment takes its thread with it');
  assert.ok(thread.disposed);
});

test('stored comments are checked when read back, and kept within bounds', () => {
  const { ReviewStore, valid } = require('../src/vscode/review');
  const ok = { id: 'a', root: '/r', repoRoot: '/r', path: 'x.js', ref: null, start: 1, end: 1, anchor: ['x'], comments: [{ id: 'c', body: 'b', time: 1 }], time: 1 };
  assert.equal(valid(ok), true);
  for (const bad of [{ path: '../x' }, { path: '.git/config' }, { ref: 'HEAD' }, { root: 'relative' }, { start: -1 }, { comments: [] }, { time: 'x' }, { anchor: ['y'.repeat(600)] }, { comments: [{ id: 'c', body: 'b', time: 'later' }] }]) {
    assert.equal(valid({ ...ok, ...bad }), false, JSON.stringify(bad).slice(0, 80));
  }
  const m = memento();
  m.data.set('reviewComments', [ok, { ...ok, id: 'b', path: '/etc/passwd' }, 'junk']);
  const s = new ReviewStore(m);
  assert.deepEqual([...s.threads.keys()], ['a']);
  s.put(Array.from({ length: 1005 }, (_, k) => ({ ...ok, id: `t${k}` })));
  assert.equal(s.threads.size, 1000);
  s.dispose();
});

test('Save never writes through a link, never over another file, never with a device name; the exclude line once', { skip: process.platform === 'win32' }, async (t) => {
  const r = createRepo();
  t.after(() => r.cleanup());
  r.commit('base', { 'a.txt': 'x\n', 'keep.md': 'mine\n' });
  const { writeReview, excludeFile, insideRoot, fileNameOk } = require('../src/vscode/review');
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-out-')), 'never.md');
  t.after(() => fs.rmSync(path.dirname(outside), { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(r.dir, 'lnk.md'));
  await assert.rejects(writeReview(r.dir, 'lnk.md', '# Review comments for x\n'));
  assert.equal(fs.existsSync(outside), false);
  await assert.rejects(writeReview(r.dir, 'keep.md', '# Review comments for x\n'), /not an earlier review/);
  assert.equal(fs.readFileSync(path.join(r.dir, 'keep.md'), 'utf8'), 'mine\n');
  // A hard link to another file: the other file keeps its content (a new file takes the name).
  fs.writeFileSync(path.join(r.dir, 'victim.txt'), '# Review comments for x\nvictim\n');
  fs.linkSync(path.join(r.dir, 'victim.txt'), path.join(r.dir, 'review.md'));
  await writeReview(r.dir, 'review.md', '# Review comments for y\n');
  assert.equal(fs.readFileSync(path.join(r.dir, 'victim.txt'), 'utf8'), '# Review comments for x\nvictim\n');
  assert.equal(fs.readFileSync(path.join(r.dir, 'review.md'), 'utf8'), '# Review comments for y\n');
  for (const bad of ['sub/x.md', '..', '.git', 'NUL', 'con.txt', 'x.md ', 'x.md.', 'a\nb']) assert.equal(fileNameOk(bad), false, bad);
  assert.equal(fileNameOk('.review-comments.md'), true);
  await excludeFile(path.join(r.dir, '.git'), 'review.md');
  await excludeFile(path.join(r.dir, '.git'), 'review.md');
  assert.equal(fs.readFileSync(path.join(r.dir, '.git', 'info', 'exclude'), 'utf8').split('\n').filter((l) => l === '/review.md').length, 1);
  // A git folder whose info is a link elsewhere: not written.
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-git-'));
  t.after(() => fs.rmSync(fake, { recursive: true, force: true }));
  fs.symlinkSync(path.dirname(outside), path.join(fake, 'info'));
  await assert.rejects(excludeFile(fake, 'review.md'));
  assert.equal(fs.existsSync(path.join(path.dirname(outside), 'exclude')), false);
  fs.mkdirSync(path.join(r.dir, 'real'));
  fs.writeFileSync(path.join(r.dir, 'real', 'f.txt'), 'x');
  fs.symlinkSync(path.join(r.dir, 'real'), path.join(r.dir, 'linked'));
  assert.equal(await insideRoot(r.dir, 'real/f.txt'), true);
  assert.equal(await insideRoot(r.dir, 'linked/f.txt'), false, 'not through a symlinked folder');
});

test('Save refuses a folder that is no longer a worktree of an open repository', async (t) => {
  const { cmds, store } = await setup(t);
  const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gone-'));
  t.after(() => fs.rmSync(gone, { recursive: true, force: true }));
  store.put([{ id: 'g', root: gone, repoRoot: gone, path: 'x.js', ref: null, start: 0, end: 0, anchor: ['x'], comments: [{ id: 'c', body: 'b', time: 1 }], time: 1 }]);
  await cmds['commitCorner.review.save']({ worktreePath: gone });
  assert.equal(fs.readdirSync(gone).length, 0, 'nothing written there');
  assert.match(mock.ui.messages.pop().msg, /not a worktree of an open repository/);
});
