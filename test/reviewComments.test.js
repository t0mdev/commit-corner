'use strict';

/**
 * Review comments for an agent: comments on lines of its work, kept per worktree, that follow
 * their lines when the file changes, and go back to the agent as one text (or a file).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createRepo } = require('./helpers/repo');
const { createVscode, installVscodeMock } = require('./helpers/vscodeMock');

const mock = createVscode();
installVscodeMock(mock);

const { Repository } = require('../src/git/repository');
const F = require('../src/vscode/review/format');

function memento() {
  const data = new Map();
  return { get: (k) => data.get(k), update: async (k, v) => (v === undefined ? data.delete(k) : data.set(k, v)), data };
}

// ------------------------------------------------------------------ text and lines

test('a comment follows its lines: same place, moved by lines added above, or changed', () => {
  const lines = ['a', 'b', '  if (x) {', '    run();', '  }', 'z'];
  const anchor = F.anchorOf(lines, 2, 3);
  assert.deepEqual(anchor, ['  if (x) {', '    run();']);
  assert.equal(F.relocate(lines, 2, anchor), 2);
  assert.equal(F.relocate(['new', 'new 2', ...lines], 2, anchor), 4, 'two lines added above');
  assert.equal(F.relocate(['if (x) {', 'run();', ...lines.slice(4)], 2, anchor), 0, 'reindented: still the same lines');
  assert.equal(F.relocate(['a', 'b', '  if (y) {', '    run();'], 2, anchor), undefined, 'the lines themselves changed');
  // The same lines twice: the nearer one.
  assert.equal(F.relocate(['x', 'if (x) {', 'run();', 'q', 'q', 'q', 'if (x) {', 'run();'], 5, anchor), 6);
  // Blank lines only: kept where it was.
  assert.equal(F.relocate(['a', '', 'c'], 1, ['', '']), 1);
});

test('the review for the agent: what to do, then each comment with its file, lines and code', () => {
  const text = F.reviewText({
    name: 'agent-1',
    branch: 'feature/login',
    threads: [
      { path: 'src/b.js', ref: null, start: 9, end: 9, code: ['return x;'], comments: ['Handle the empty case.', 'And log it.'] },
      { path: 'src/a.js', ref: 'a'.repeat(40), start: 0, end: 1, code: ['const s = `x`;', '```'], comments: ['Use a constant.'] },
      { path: 'gone.js', ref: null, start: 4, end: 4, outdated: true, code: ['old line'], comments: ['Rename this.'] },
    ],
  });
  assert.match(text, /^# Review comments for branch `feature\/login` \(agent-1\)\n/);
  assert.match(text, /Please address these 3 review comments\. Line numbers are those of the files as they are now, unless a commit is named\./);
  const order = ['gone.js', 'src/a.js', 'src/b.js'].map((p) => text.indexOf(`\`${p}\``));
  assert.deepEqual([...order].sort((x, y) => x - y), order, 'sorted by file');
  assert.match(text, /## 2\. `src\/a\.js`, lines 1–2 in commit aaaaaaa/);
  assert.match(text, /## 3\. `src\/b\.js`, line 10\n\n```\n10  return x;\n```\n\nHandle the empty case\.\nAlso: And log it\./);
  assert.match(text, /## 1\. `gone\.js`, line 5 \(these lines have changed since the comment\)/);
  // Code with a ``` inside: a longer fence, so it cannot end the block.
  assert.match(text, /````\n1  const s = `x`;\n2  ```\n````/);
  assert.equal(F.codeSpan('a`b'), '``a`b``');
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
  const manager = {
    repositories: [repo],
    getRepository: (root) => (root === repo.root ? repo : undefined),
    getRepositoryForUri: (uri) => (uri.fsPath === repo.root || uri.fsPath.startsWith(repo.root + path.sep) ? repo : undefined),
  };
  const review = require('../src/vscode/review');
  review.register({ manager, command: (id, fn) => (cmds[id] = fn), extContext: { workspaceState: memento(), subscriptions: subs } });
  t.after(() => subs.forEach((d) => d.dispose && d.dispose()));
  const controller = mock.commentControllers[mock.commentControllers.length - 1];
  /** An open editor's document for a file (its text from disk). */
  const open = (uri) => {
    const doc = { uri, getText: () => fs.readFileSync(uri.fsPath, 'utf8'), get lineCount() { return this.getText().split('\n').length; } };
    mock.vscode.workspace.textDocuments.push(doc);
    t.after(() => mock.vscode.workspace.textDocuments.splice(mock.vscode.workspace.textDocuments.indexOf(doc), 1));
    return doc;
  };
  return { r, repo, cmds, controller, open, store: review.get() };
}

test('comment on a line of an agent\'s worktree, the agent edits above it, the review still points at it', async (t) => {
  const { r, repo, cmds, controller, open, store } = await setup(t);
  r.commit('base', { 'app.js': 'one\ntwo\nfunction load(items) {\n  return items[0];\n}\n' });
  const wt = path.join(path.dirname(r.dir), `${path.basename(r.dir)}-agent`);
  r.git('worktree', 'add', '-q', '-b', 'agent/login', wt);
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));
  const file = mock.vscode.Uri.file(path.join(fs.realpathSync(wt), 'app.js'));
  open(file);
  // The + on line 4 ("return items[0];"), then Add Comment.
  const thread = controller.newThread(file, new mock.vscode.Range(3, 0, 3, 0));
  await cmds['commitCorner.review.add']({ thread, text: '  Handle an empty list.  ' });
  const [saved] = store.forRoot(fs.realpathSync(wt));
  assert.ok(saved, 'kept under the agent\'s worktree');
  assert.equal(saved.path, 'app.js');
  assert.deepEqual(saved.anchor, ['  return items[0];']);
  assert.equal(thread.comments[0].body, 'Handle an empty list.');
  assert.equal(thread.label, 'For the agent');
  // A reply.
  await cmds['commitCorner.review.reply']({ thread, text: 'With a test.' });
  assert.equal(store.forRoot(fs.realpathSync(wt))[0].comments.length, 2);
  // The agent adds two lines at the top.
  fs.writeFileSync(path.join(wt, 'app.js'), '// header\n// more\none\ntwo\nfunction load(items) {\n  return items[0];\n}\n');
  await cmds['commitCorner.review.copy']({ worktreePath: wt });
  const text = mock.vscode.env.clipboard.text;
  assert.match(text, /# Review comments for branch `agent\/login`/);
  assert.match(text, /`app\.js`, line 6\n\n```\n6 {4}return items\[0\];\n```\n\nHandle an empty list\.\nAlso: With a test\./);
  // Saved as a file in the worktree, which git ignores.
  await cmds['commitCorner.review.save']({ worktreePath: wt });
  assert.equal(fs.readFileSync(path.join(wt, '.review-comments.md'), 'utf8'), text);
  assert.equal(r.git('status', '--porcelain', { cwd: wt }), '', 'git does not see it');
  assert.match(fs.readFileSync(path.join(repo.commonDir, 'info', 'exclude'), 'utf8'), /^\/\.review-comments\.md$/m);
  // The comment's line itself changed: still in the review, said to have changed.
  fs.writeFileSync(path.join(wt, 'app.js'), '// header\n// more\none\ntwo\nfunction load(items) {\n  return items.length ? items[0] : null;\n}\n');
  await cmds['commitCorner.review.copy']({ worktreePath: wt });
  assert.match(mock.vscode.env.clipboard.text, /line 6 \(these lines have changed since the comment\)\n\n```\n6 {4}return items\[0\];/);
  // Clear (asked first).
  mock.ui.answers.push('Delete');
  await cmds['commitCorner.review.clear']({ worktreePath: wt });
  assert.equal(store.forRoot(fs.realpathSync(wt)).length, 0);
  assert.ok(thread.disposed, 'its thread goes from the editor');
});

test('a comment on a commit\'s revision names the commit; the index and moving refs take none', async (t) => {
  const { r, repo, cmds, controller, store } = await setup(t);
  const sha = r.commit('base', { 'a.txt': 'x\ny\n' });
  const { toGitUri } = require('../src/vscode/uri');
  const rev = toGitUri(repo.root, 'a.txt', sha, { commit: sha });
  const provider = controller.commentingRangeProvider;
  const doc = (uri) => ({ uri, lineCount: 2, getText: () => 'x\ny\n' });
  assert.equal((await provider.provideCommentingRanges(doc(rev))).length, 1);
  assert.equal((await provider.provideCommentingRanges(doc(toGitUri(repo.root, 'a.txt', ':')))).length, 0, 'the index');
  assert.equal((await provider.provideCommentingRanges(doc(toGitUri(repo.root, 'a.txt', 'HEAD')))).length, 0, 'a ref that moves');
  assert.equal((await provider.provideCommentingRanges(doc(mock.vscode.Uri.file('/elsewhere/x.txt')))).length, 0, 'outside every repository');
  const thread = controller.newThread(rev, new mock.vscode.Range(1, 0, 1, 0));
  await cmds['commitCorner.review.add']({ thread, text: 'Why y?' });
  const [t1] = store.forRoot(repo.root);
  assert.equal(t1.ref, sha);
  await cmds['commitCorner.review.copy']({ reviewRoot: repo.root });
  assert.match(mock.vscode.env.clipboard.text, new RegExp(`\`a\\.txt\`, line 2 in commit ${sha.slice(0, 7)}\\n\\n\`\`\`\\n2  y\\n\`\`\`\\n\\nWhy y\\?`));
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
  c1.body = 'first, edited';
  await cmds['commitCorner.review.saveComment'](c1);
  assert.equal(store.forRoot(repo.root)[0].comments[0].body, 'first, edited');
  await cmds['commitCorner.review.editComment'](c2);
  c2.body = 'not saved';
  await cmds['commitCorner.review.cancelEdit'](c2);
  assert.equal(c2.body, 'second');
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
  for (const bad of [{ path: '../x' }, { path: '.git/config' }, { ref: 'HEAD' }, { root: 'relative' }, { start: -1 }, { comments: [] }]) assert.equal(valid({ ...ok, ...bad }), false, JSON.stringify(bad));
  const m = memento();
  m.data.set('reviewComments', [ok, { ...ok, id: 'b', path: '/etc/passwd' }, 'junk']);
  const s = new ReviewStore(m);
  assert.deepEqual([...s.threads.keys()], ['a']);
  for (let k = 0; k < 1005; k++) s.put({ ...ok, id: `t${k}` });
  assert.equal(s.threads.size, 1000);
  s.dispose();
});

test('the review file is never written through a link, and its exclude line is added once', { skip: process.platform === 'win32' }, async (t) => {
  const r = createRepo();
  t.after(() => r.cleanup());
  r.commit('base', { 'a.txt': 'x\n' });
  const { writeReview, excludeFile, insideRoot } = require('../src/vscode/review');
  fs.symlinkSync('/tmp/cc-never-written', path.join(r.dir, 'lnk.md'));
  await assert.rejects(writeReview(path.join(r.dir, 'lnk.md'), 'x'));
  assert.equal(fs.existsSync('/tmp/cc-never-written'), false);
  await excludeFile(r.dir, 'review.md');
  await excludeFile(r.dir, 'review.md');
  const lines = fs.readFileSync(path.join(r.dir, '.git', 'info', 'exclude'), 'utf8').split('\n').filter((l) => l === '/review.md');
  assert.equal(lines.length, 1);
  fs.mkdirSync(path.join(r.dir, 'real'));
  fs.writeFileSync(path.join(r.dir, 'real', 'f.txt'), 'x');
  fs.symlinkSync(path.join(r.dir, 'real'), path.join(r.dir, 'linked'));
  assert.equal(await insideRoot(r.dir, 'real/f.txt'), true);
  assert.equal(await insideRoot(r.dir, 'linked/f.txt'), false, 'not through a symlinked folder');
});
