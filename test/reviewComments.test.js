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

test('a comment stays on its own "}" when a neighbour is edited, and a changed "}" does not jump to another', () => {
  const lines = ['function a() {', '  return null;', '}', '', 'function b() {', '  two();', '}', ''];
  const below = [...lines];
  below[3] = '// note';
  assert.equal(find(lines, 2, 2, below), 2, 'the line below edited');
  const above = [...lines];
  above[1] = '  return 1;';
  assert.equal(find(lines, 2, 2, above), 2, 'the line above edited');
  const changed = [...lines];
  changed[6] = '};';
  assert.equal(find(lines, 6, 6, changed), undefined, 'b\'s brace edited: changed, not a\'s');
  // A distinctive line is found anywhere; a short one only close by.
  assert.equal(find(['x', 'const total = sum(items);', 'y'], 1, 1, ['const total = sum(items);', 'p', 'q', 'r', 'x', 'y']), 0);
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
    const doc = {
      uri,
      getText: () => fs.readFileSync(uri.fsPath, 'utf8'),
      get lineCount() {
        return this.getText().split('\n').length;
      },
      lineAt(i) {
        return { text: this.getText().split('\n')[i] };
      },
    };
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
  assert.match(clip(), /line 6 \(these lines have changed since the comment; they were:\)\n\n```js\n {2}return items\[0\];\n```\n\nNow, line 6:\n\n```js\n6 {4}return items\.length \? items\[0\] : null;\n```/);
  // Delete All (asked first).
  mock.ui.answers.push('Delete');
  await cmds['commitCorner.review.clear']({ worktreePath: wt });
  assert.equal(store.forRoot(wt).length, 0);
  assert.ok(thread.disposed, 'its thread goes from the editor');
});

test('lines deleted around a comment and the deletion undone: the comment is back on its lines', async (t) => {
  const { r, repo, cmds, controller, open, store } = await setup(t);
  const text = Array.from({ length: 14 }, (_, k) => `line ${k}`).join('\n') + '\n';
  r.commit('base', { 'f.txt': text });
  const file = mock.vscode.Uri.file(path.join(repo.root, 'f.txt'));
  const doc = open(file);
  const thread = controller.newThread(file, new mock.vscode.Range(10, 0, 11, 0));
  await cmds['commitCorner.review.add']({ thread, text: 'Look here.' });
  // Lines 9-12 deleted.
  const lines = text.split('\n');
  fs.writeFileSync(file.fsPath, [...lines.slice(0, 9), ...lines.slice(13)].join('\n'));
  mock.events.onDidChangeTextDocument.fire({ document: doc, contentChanges: [{ range: new mock.vscode.Range(9, 0, 13, 0), text: '' }] });
  assert.match(thread.label, /these lines have changed/);
  // Undone: they come back at line 9.
  fs.writeFileSync(file.fsPath, text);
  mock.events.onDidChangeTextDocument.fire({ document: doc, contentChanges: [{ range: new mock.vscode.Range(9, 0, 9, 0), text: 'line 9\nline 10\nline 11\nline 12\n' }] });
  assert.equal(thread.range.start.line, 10);
  assert.doesNotMatch(thread.label, /changed/);
  assert.equal(store.forRoot(repo.root)[0].outdated, false);
  // Enter typed at the start of the commented line: it moves down with it.
  fs.writeFileSync(file.fsPath, [...lines.slice(0, 10), '', ...lines.slice(10)].join('\n'));
  mock.events.onDidChangeTextDocument.fire({ document: doc, contentChanges: [{ range: new mock.vscode.Range(10, 0, 10, 0), text: '\n' }] });
  assert.equal(thread.range.start.line, 11);
  assert.doesNotMatch(thread.label, /changed/);
});

/** Comment on line `at` of a file with these lines, in an open editor. */
async function commented(t, lines, at) {
  const env = await setup(t);
  env.r.commit('base', { 'f.js': lines.join('\n') });
  const file = mock.vscode.Uri.file(path.join(env.repo.root, 'f.js'));
  const doc = env.open(file);
  const thread = env.controller.newThread(file, new mock.vscode.Range(at, 0, at, 0));
  await env.cmds['commitCorner.review.add']({ thread, text: 'here' });
  /** The file rewritten (on disk, as an agent does) and the edit VS Code reports. */
  const edit = (now, range, text) => {
    fs.writeFileSync(file.fsPath, now.join('\n'));
    mock.events.onDidChangeTextDocument.fire({ document: doc, contentChanges: [{ range: new mock.vscode.Range(...range), text }] });
  };
  return { ...env, file, doc, thread, edit };
}

const blocks = (names) => names.flatMap((n) => [`function ${n}() {`, '  if (ok) {', '    done();', '  }', '}', '']);

test('an open file the agent rewrote (one change from its first to its last line): the comment stays on its "}"', async (t) => {
  const lines = blocks(['a', 'b', 'c']);
  const { thread, edit, store, repo } = await commented(t, lines, 16); // c's closing brace
  const now = [...lines];
  now[0] = 'function a1() {';
  now[now.length - 1] = '// end';
  edit(now, [0, 0, lines.length - 1, 0], now.join('\n'));
  assert.equal(thread.range.start.line, 16);
  assert.doesNotMatch(thread.label, /changed/);
  assert.equal(store.forRoot(repo.root)[0].outdated, false);
});

test('lines pasted right above a commented "}" move it down; it stays as it was', async (t) => {
  const lines = blocks(['a', 'b']);
  const { thread, edit } = await commented(t, lines, 4);
  const pasted = ['// x', '// y', '// z'];
  edit([...lines.slice(0, 4), ...pasted, ...lines.slice(4)], [4, 0, 4, 0], `${pasted.join('\n')}\n`);
  assert.equal(thread.range.start.line, 7);
  assert.doesNotMatch(thread.label, /changed/);
});

test('a "}" whose own line was deleted does not turn up at another block\'s identical "}"', () => {
  const lines = blocks(['a', 'b']);
  const where = F.anchorOf(lines, 10, 10); // b's brace: "  }" above, "" below
  const now = lines.filter((_, k) => k !== 10);
  assert.notEqual(F.relocate(F.normLines(now), 10, where), 4, 'not a\'s brace (same neighbours, far away)');
  // Nor when nothing is close by.
  const far = [...blocks(['a']), ...Array.from({ length: 20 }, (_, k) => `// ${k}`), 'x'];
  assert.equal(F.relocate(F.normLines(far), 25, { anchor: ['}'], before: '  }', after: '' }), undefined);
});

test('the review notices lines that changed in an open editor, and the editor says so too', async (t) => {
  const lines = ['const a = 1;', 'const b = 2;', 'const c = 3;'];
  const { thread, cmds, repo, file, clip } = await commented(t, lines, 1);
  fs.writeFileSync(file.fsPath, ['const a = 1;', 'const b = 20;', 'const c = 3;'].join('\n')); // no edit event: changed behind the editor's back
  await cmds['commitCorner.review.copy']({ reviewRoot: repo.root });
  assert.match(clip(), /these lines have changed/);
  assert.match(thread.label, /these lines have changed/);
});

test('an agent rewriting a big open file with 50 comments in it costs little', async (t) => {
  const lines = Array.from({ length: 200000 }, (_, k) => `const v${k} = ${k};`);
  const env = await setup(t);
  env.r.commit('base', { 'big.js': lines.join('\n') });
  const file = mock.vscode.Uri.file(path.join(env.repo.root, 'big.js'));
  const text = lines.join('\n');
  const doc = { uri: file, getText: () => text, lineCount: lines.length, lineAt: (i) => ({ text: lines[i] }) };
  mock.vscode.workspace.textDocuments.push(doc);
  t.after(() => mock.vscode.workspace.textDocuments.splice(mock.vscode.workspace.textDocuments.indexOf(doc), 1));
  const threads = [];
  for (let k = 0; k < 50; k++) {
    const th = env.controller.newThread(file, new mock.vscode.Range(1000 + k * 3000, 0, 1000 + k * 3000, 0));
    await env.cmds['commitCorner.review.add']({ thread: th, text: `c${k}` });
    threads.push(th);
  }
  const t0 = Date.now();
  mock.events.onDidChangeTextDocument.fire({ document: doc, contentChanges: [{ range: new mock.vscode.Range(0, 0, lines.length - 1, 0), text }] });
  assert.ok(Date.now() - t0 < 200, `${Date.now() - t0} ms`);
  assert.ok(threads.every((th, k) => th.range.start.line === 1000 + k * 3000));
});

test('a deleted inner "}" does not land on the function\'s own "}"', () => {
  const lines = ['function f() {', '  if (x) {', '    go();', '  }', '}', ''];
  const where = F.anchorOf(lines, 3, 3); // the if's brace
  const now = ['function f() {', '  if (x) {', '}', '']; // "    go();" and "  }" deleted
  assert.equal(F.relocate(F.normLines(now), 3, where), undefined);
});

test('a comment whose lines are gone: an edit far above only moves it; a paste at its start moves it, a restore finds it', async (t) => {
  const lines = Array.from({ length: 30 }, (_, k) => `const v${k} = ${k};`);
  const { thread, edit } = await commented(t, lines, 10);
  // Its line changed: "changed".
  const changed = [...lines];
  changed[10] = 'const v10 = 1000;';
  edit(changed, [10, 13, 10, 15], '1000');
  assert.match(thread.label, /changed/);
  // Five lines pasted at the top: it moves with them, still "changed" (nothing looked for far away).
  const top = Array.from({ length: 5 }, (_, k) => `// ${k}`);
  edit([...top, ...changed], [0, 0, 0, 0], `${top.join('\n')}\n`);
  assert.equal(thread.range.start.line, 15);
  assert.match(thread.label, /changed/);
  // Three lines pasted right at its start: it moves down with its line.
  const mid = ['// a', '// b', '// c'];
  const now = [...top, ...changed.slice(0, 10), ...mid, ...changed.slice(10)];
  edit(now, [15, 0, 15, 0], `${mid.join('\n')}\n`);
  assert.equal(thread.range.start.line, 18);
  // Its line restored: found again, not "changed".
  const restored = [...now];
  restored[18] = 'const v10 = 10;';
  edit(restored, [18, 13, 18, 17], '10');
  assert.equal(thread.range.start.line, 18);
  assert.doesNotMatch(thread.label, /changed/);
});

test('one edit that adds lines above a comment and changes its line parks it on its own line', async (t) => {
  const lines = Array.from({ length: 12 }, (_, k) => `const v${k} = ${k};`);
  const { thread, doc, file } = await commented(t, lines, 6);
  // As a formatter reports it, in one edit: two lines added at the top, the commented line rewritten.
  const now = ['// a', '// b', ...lines];
  now[8] = 'const v6 = 600;';
  fs.writeFileSync(file.fsPath, now.join('\n'));
  mock.events.onDidChangeTextDocument.fire({ document: doc, contentChanges: [{ range: new mock.vscode.Range(0, 0, 0, 0), text: '// a\n// b\n' }, { range: new mock.vscode.Range(6, 13, 6, 14), text: '600' }] });
  assert.equal(thread.range.start.line, 8);
  assert.match(thread.label, /changed/);
});

test('a CRLF paste right above a comment, and a reload reported as one change ending at its line, move it as they should', async (t) => {
  const lines = blocks(['a', 'b']);
  const { thread, edit } = await commented(t, lines, 9);
  edit([...lines.slice(0, 9), 'x', 'y', ...lines.slice(9)], [9, 0, 9, 0], 'x\r\ny\r\n');
  assert.equal(thread.range.start.line, 11);
  // VS Code's reload: one change from the first changed line to column 0 of the first unchanged one.
  const now = ['// header', ...lines.slice(0, 9), 'x', 'y', ...lines.slice(9)];
  edit(now, [0, 0, 1, 0], '// header\nfunction a() {\n');
  assert.equal(thread.range.start.line, 12);
  assert.doesNotMatch(thread.label, /changed/);
});

test('a reloaded big file in which 10 of 50 comments changed costs little too', async (t) => {
  const lines = Array.from({ length: 200000 }, (_, k) => `const v${k} = ${k};`);
  const env = await setup(t);
  env.r.commit('base', { 'big.js': lines.join('\n') });
  const file = mock.vscode.Uri.file(path.join(env.repo.root, 'big.js'));
  let current = lines;
  const doc = { uri: file, getText: () => current.join('\n'), get lineCount() { return current.length; }, lineAt: (i) => ({ text: current[i] }) };
  mock.vscode.workspace.textDocuments.push(doc);
  t.after(() => mock.vscode.workspace.textDocuments.splice(mock.vscode.workspace.textDocuments.indexOf(doc), 1));
  const threads = [];
  for (let k = 0; k < 50; k++) {
    const th = env.controller.newThread(file, new mock.vscode.Range(1000 + k * 3000, 0, 1000 + k * 3000, 0));
    await env.cmds['commitCorner.review.add']({ thread: th, text: `c${k}` });
    threads.push(th);
  }
  current = lines.map((l, i) => (i % 15000 === 1000 ? `${l} // changed` : l)); // 10 of the commented lines
  const t0 = Date.now();
  mock.events.onDidChangeTextDocument.fire({ document: doc, contentChanges: [{ range: new mock.vscode.Range(0, 0, lines.length - 1, 0), text: current.join('\n') }] });
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
  assert.equal(threads.filter((th) => /changed/.test(th.label)).length, 10);
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
  // From the keyboard in that commit's diff, with comments in the repository too: the agent's review.
  fs.writeFileSync(path.join(repo.root, 'a.txt'), 'x\n');
  const mine = controller.newThread(mock.vscode.Uri.file(path.join(repo.root, 'a.txt')), new mock.vscode.Range(0, 0, 0, 0));
  await cmds['commitCorner.review.add']({ thread: mine, text: 'mine' });
  mock.vscode.window.activeTextEditor = { document: { uri: rev } };
  t.after(() => (mock.vscode.window.activeTextEditor = undefined));
  await cmds['commitCorner.review.copy']();
  assert.match(clip(), /Why here/);
  assert.doesNotMatch(clip(), /mine/);
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

/** Comments in two worktrees (so a command without its comment would ask which): the agent's on f.txt line 2, the repository's on line 1. */
async function twoWorktrees(t) {
  const s = await setup(t);
  s.r.commit('base', { 'f.txt': 'a\nb\n' });
  const wt = path.join(s.repo.root, '..', 'wt-menu');
  gitIn(s.repo.root, 'worktree', 'add', '-q', '-b', 'agent/menu', wt);
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));
  const mine = mock.vscode.Uri.file(path.join(wt, 'f.txt'));
  const other = mock.vscode.Uri.file(path.join(s.repo.root, 'f.txt'));
  s.open(mine);
  s.open(other);
  const thread = s.controller.newThread(mine, new mock.vscode.Range(1, 0, 1, 0));
  await s.cmds['commitCorner.review.add']({ thread, text: 'in the worktree' });
  const elsewhere = s.controller.newThread(other, new mock.vscode.Range(0, 0, 0, 0));
  await s.cmds['commitCorner.review.add']({ thread: elsewhere, text: 'in the repository' });
  mock.vscode.env.clipboard.text = 'before';
  t.after(() => (mock.vscode.window.activeTextEditor = undefined));
  return { ...s, wt, mine, other, thread, comment: thread.comments[0] };
}

test("a comment's menu: Copy and Save are for its worktree, without asking which", async (t) => {
  const { repo, wt, cmds, clip, comment } = await twoWorktrees(t);
  await cmds['commitCorner.review.copy'](comment);
  assert.match(clip(), /in the worktree/);
  assert.doesNotMatch(clip(), /in the repository/);
  await cmds['commitCorner.review.save'](comment);
  assert.match(fs.readFileSync(path.join(wt, '.review-comments.md'), 'utf8'), /in the worktree/);
  assert.ok(!fs.existsSync(path.join(repo.root, '.review-comments.md')));
});

test('while a comment is being edited, Copy and Save do nothing but say so (the review takes the saved text)', async (t) => {
  const { wt, cmds, clip, comment } = await twoWorktrees(t);
  await cmds['commitCorner.review.editComment'](comment);
  for (const id of ['commitCorner.review.copy', 'commitCorner.review.save']) {
    mock.ui.messages.length = 0;
    await cmds[id](comment);
    assert.match(mock.ui.messages.at(-1).msg, /Save \(or cancel\) the comment you are editing first/, id);
  }
  assert.equal(clip(), 'before');
  assert.ok(!fs.existsSync(path.join(wt, '.review-comments.md')));
  await cmds['commitCorner.review.cancelEdit'](comment);
  await cmds['commitCorner.review.copy'](comment);
  assert.match(clip(), /in the worktree/);
});

test("from the keyboard, Copy takes the worktree of the file in front of you", async (t) => {
  const { cmds, clip, other, mine } = await twoWorktrees(t);
  mock.vscode.window.activeTextEditor = { document: { uri: other } };
  await cmds['commitCorner.review.copy']();
  assert.match(clip(), /in the repository/);
  assert.doesNotMatch(clip(), /in the worktree/);
  mock.vscode.window.activeTextEditor = { document: { uri: mine } };
  await cmds['commitCorner.review.copy']();
  assert.match(clip(), /in the worktree/);
});

test("Delete All from a comment's menu asks first, says what goes, and leaves other worktrees alone", async (t) => {
  const { repo, wt, cmds, thread, comment, store } = await twoWorktrees(t);
  await cmds['commitCorner.review.reply']({ thread, text: 'a reply' });
  mock.ui.answers.push(undefined);
  await cmds['commitCorner.review.clear'](comment);
  assert.equal(store.forRoot(wt).length, 1, 'kept when not confirmed');
  const asked = mock.ui.messages.at(-1);
  assert.equal(asked.msg, 'Delete the review comment of branch agent/menu?');
  assert.match(asked.detail, /^In f\.txt, with 1 reply\. This cannot be undone/);
  mock.ui.answers.push('Delete');
  await cmds['commitCorner.review.clear'](comment);
  assert.equal(store.forRoot(wt).length, 0);
  assert.ok(thread.disposed);
  assert.equal(store.forRoot(repo.root).length, 1, "the other worktree's comment stays");
});

test("a deleted comment's (or thread's) menu does nothing, never another worktree's review; with nothing left, the commands say so", async (t) => {
  const { repo, wt, cmds, clip, thread, comment } = await twoWorktrees(t);
  mock.ui.answers.push('Delete');
  await cmds['commitCorner.review.clear']({ reviewRoot: wt });
  // Still on screen a moment: the repository has the only comments now, which must not be taken instead.
  const args = { comment, 'a comment VS Code no longer knows': { $mid: 1, commentUniqueId: 3, thread: { $mid: 2 } }, thread, 'a thread VS Code no longer knows': { $mid: 2, commentControlHandle: 0, commentThreadHandle: 4 } };
  for (const [name, arg] of Object.entries(args)) {
    mock.ui.messages.length = 0;
    await cmds['commitCorner.review.copy'](arg);
    assert.equal(clip(), 'before', name);
    assert.match(mock.ui.messages.at(-1).msg, /gone/);
  }
  mock.ui.answers.push('Delete');
  await cmds['commitCorner.review.clear']({ reviewRoot: repo.root });
  for (const id of ['commitCorner.review.copy', 'commitCorner.review.save', 'commitCorner.review.clear']) {
    mock.ui.messages.length = 0;
    await cmds[id]();
    assert.match(mock.ui.messages.at(-1).msg, /No review comments yet/, id);
  }
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
  for (const bad of ['sub/x.md', '..', '.git', 'NUL', 'con.txt', 'x.md ', 'x.md.', 'a\nb', 'GIT~1', 'review\u202e.md', 'CONIN$', 'COM¹', 'a\u200bb.md', '\ufeffx.md']) assert.equal(fileNameOk(bad), false, bad);
  assert.equal(fileNameOk('.review-comments.md'), true);
  const own = { commonDir: path.join(r.dir, '.git'), gitDir: path.join(r.dir, '.git') };
  await excludeFile(own, 'review.md');
  await excludeFile(own, 'review.md');
  const excluded = fs.readFileSync(path.join(r.dir, '.git', 'info', 'exclude'), 'utf8').split('\n');
  assert.equal(excluded.filter((l) => l === '/review.md').length, 1);
  assert.equal(excluded.filter((l) => l === '/.review.md.*.tmp').length, 1, 'its temporary twin too');
  // A repository whose git dir is not its common dir nor one of its worktrees': nothing written there.
  await assert.rejects(excludeFile({ commonDir: path.join(r.dir, '.git'), gitDir: os.tmpdir() }, 'x.md'), /not its own/);
  // A git folder whose info is a link elsewhere: not written.
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-git-'));
  t.after(() => fs.rmSync(fake, { recursive: true, force: true }));
  fs.symlinkSync(path.dirname(outside), path.join(fake, 'info'));
  await assert.rejects(excludeFile({ commonDir: fake, gitDir: fake }, 'review.md'));
  assert.equal(fs.existsSync(path.join(path.dirname(outside), 'exclude')), false);
  fs.mkdirSync(path.join(r.dir, 'real'));
  fs.writeFileSync(path.join(r.dir, 'real', 'f.txt'), 'x');
  fs.symlinkSync(path.join(r.dir, 'real'), path.join(r.dir, 'linked'));
  assert.equal(await insideRoot(r.dir, 'real/f.txt'), true);
  assert.equal(await insideRoot(r.dir, 'linked/f.txt'), false, 'not through a symlinked folder');
});

test('Save leaves a file of that name that is not a review alone, and does not hide it from git', async (t) => {
  const { r, repo, cmds, controller, open } = await setup(t);
  r.commit('base', { 'f.txt': 'a\n' });
  fs.writeFileSync(path.join(repo.root, '.review-comments.md'), 'my own notes\n');
  const file = mock.vscode.Uri.file(path.join(repo.root, 'f.txt'));
  open(file);
  await cmds['commitCorner.review.add']({ thread: controller.newThread(file, new mock.vscode.Range(0, 0, 0, 0)), text: 'x' });
  await cmds['commitCorner.review.save']({ reviewRoot: repo.root });
  assert.equal(fs.readFileSync(path.join(repo.root, '.review-comments.md'), 'utf8'), 'my own notes\n');
  assert.match(mock.ui.messages.pop().msg, /not an earlier review/);
  const exclude = path.join(repo.commonDir, 'info', 'exclude');
  assert.doesNotMatch(fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '', /review-comments/);
});

test('Save writes into a worktree reached through a symlinked parent, never into one that became a link', { skip: process.platform === 'win32' }, async (t) => {
  const { writeReview } = require('../src/vscode/review');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-parent-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(base, 'real', 'wt'), { recursive: true });
  fs.symlinkSync(path.join(base, 'real'), path.join(base, 'via'));
  await writeReview(path.join(base, 'via', 'wt'), 'r.md', '# Review comments for x\n');
  assert.equal(fs.readFileSync(path.join(base, 'real', 'wt', 'r.md'), 'utf8'), '# Review comments for x\n');
  fs.mkdirSync(path.join(base, 'elsewhere'));
  fs.symlinkSync(path.join(base, 'elsewhere'), path.join(base, 'wt-link'));
  await assert.rejects(writeReview(path.join(base, 'wt-link'), 'r.md', '# Review comments for x\n'), /is a link/);
  assert.equal(fs.existsSync(path.join(base, 'elsewhere', 'r.md')), false);
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

test('a comment\'s row in the Worktrees view shows its first line without Markdown marks', () => {
  const { ReviewThreadNode } = require('../src/vscode/views/worktreesView');
  const row = (body) => new ReviewThreadNode({}, { id: 'x', path: 'src/a.js', ref: null, start: 4, end: 4, anchor: [], comments: [{ id: 'c', body, time: 1 }] }).getTreeItem();
  assert.equal(row('**A** or **B**: see `load()` and [the docs](https://x)').description, 'A or B: see load() and the docs');
  assert.equal(row('```js\nconst x = 1;\n```\nuse snake_case_name, not 2*3*4').description, 'use snake_case_name, not 2*3*4');
  assert.equal(row('# Rename _x_ and _y_').description, 'Rename x and y');
  assert.equal(row('x').label, 'a.js:5');
});
