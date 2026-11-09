'use strict';

/**
 * Activation and command-level tests of the VS Code layer, run against the
 * in-memory vscode mock and real temporary git repositories.
 */

const test = require('node:test');

// Every queued dialog answer must be used by its own test: a leftover one would answer the next
// test's dialog (and hide that a dialog was not shown).
test.afterEach(() => {
  const left = mock.ui.answers.splice(0);
  if (left.length) throw new Error(`answers left unused: ${JSON.stringify(left)}`);
});
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createVscode, installVscodeMock } = require('./helpers/vscodeMock');
const { createRepo } = require('./helpers/repo');

const pkg = require('../package.json');
const mock = createVscode();
installVscodeMock(mock);
const { activate } = require('../src/extension');

let r;
let api;
let extContext;

function memento() {
  const m = new Map();
  return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => m.set(k, v), keys: () => [...m.keys()] };
}

test.before(async () => {
  r = createRepo();
  r.commit('initial', { 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'b\n' });
  mock.workspaceFolders.push({ uri: mock.vscode.Uri.file(r.dir), name: 'repo', index: 0 });
  extContext = {
    subscriptions: [],
    extensionUri: mock.vscode.Uri.file(path.join(__dirname, '..')),
    extensionPath: path.join(__dirname, '..'),
    workspaceState: memento(),
    globalState: memento(),
    globalStorageUri: mock.vscode.Uri.file(fs.mkdtempSync(path.join(require('os').tmpdir(), 'cc-storage-'))),
  };
  api = await activate(extContext);
  assert.ok(api, 'activate() returned an API');
});

test.after(() => {
  for (const d of extContext.subscriptions) {
    try {
      d.dispose();
    } catch { /* ignore */ }
  }
  r.cleanup();
});

const repo = () => api.manager.repositories[0];
const run = (id, ...args) => mock.vscode.commands.executeCommand(id, ...args);

test('every command in package.json is registered and vice versa', () => {
  const declared = new Set(pkg.contributes.commands.map((c) => c.command));
  const registered = new Set(mock.commands.keys());
  const missing = [...declared].filter((c) => !registered.has(c));
  const undeclared = [...registered].filter((c) => !declared.has(c));
  assert.deepEqual(missing, [], 'declared but not registered');
  assert.deepEqual(undeclared, [], 'registered but not declared');
});

test('every view in package.json gets a tree view or a webview view provider', () => {
  for (const v of pkg.contributes.views.commitCorner) {
    if (v.type === 'webview') assert.ok(mock.webviewViews.has(v.id), v.id);
    else assert.ok(mock.treeViews.has(v.id), v.id);
  }
  // VS Code suggests 3-5 views per container; the owner chose six (Worktrees has its own view).
  assert.ok(pkg.contributes.views.commitCorner.length <= 6);
});

/** A root group of the Repository view by label (Stashes, Worktrees, Local, ...). */
async function repositoryGroup(label) {
  const roots = await mock.treeViews.get('commitCorner.branches').provider.getChildren();
  return roots.find((n) => n.getTreeItem().label === label);
}

test('the workspace repository is discovered and gets an SCM provider', () => {
  assert.equal(api.manager.repositories.length, 1);
  assert.equal(repo().root, r.dir);
  assert.equal(mock.sourceControls.length, 1);
  assert.deepEqual(mock.sourceControls[0].groups.map((g) => g.id), ['merge', 'staged', 'unstaged', 'untracked']);
});

test('SCM groups follow the working tree; stage and unstage via commands', async () => {
  r.write('a.txt', 'one\nTWO\nthree\n');
  r.write('new.txt', 'new\n');
  await api.manager.refresh(repo());
  const sc = mock.sourceControls[0];
  const [, staged, unstaged, untracked] = sc.groups;
  assert.deepEqual(unstaged.resourceStates.map((s) => s.path), ['a.txt']);
  assert.deepEqual(untracked.resourceStates.map((s) => s.path), ['new.txt']);
  await run('commitCorner.stage', unstaged.resourceStates[0], [unstaged.resourceStates[0], untracked.resourceStates[0]]);
  await api.manager.refresh(repo());
  assert.deepEqual(staged.resourceStates.map((s) => s.path).sort(), ['a.txt', 'new.txt']);
  await run('commitCorner.unstage', staged.resourceStates.find((s) => s.path === 'new.txt'));
  await api.manager.refresh(repo());
  assert.deepEqual(staged.resourceStates.map((s) => s.path), ['a.txt']);
});

test('commit from the input box, then undo it', async () => {
  const sc = mock.sourceControls[0];
  sc.inputBox.value = 'Change two';
  await run('commitCorner.commit', { repoRoot: r.dir });
  assert.equal(r.git('log', '-1', '--format=%s'), 'Change two');
  assert.equal(sc.inputBox.value, '');
  await run('commitCorner.undoLastCommit', { repoRoot: r.dir });
  assert.equal(r.git('log', '-1', '--format=%s'), 'initial');
  assert.equal(sc.inputBox.value, 'Change two');
  await run('commitCorner.commit', { repoRoot: r.dir });
  assert.equal(r.git('log', '-1', '--format=%s'), 'Change two');
});

test('smart commit asks before staging everything', async () => {
  r.write('b.txt', 'b2\n');
  await api.manager.refresh(repo());
  const sc = mock.sourceControls[0];
  sc.inputBox.value = 'Update b';
  mock.ui.answers.push('Tracked Files Only');
  await run('commitCorner.commit', { repoRoot: r.dir });
  assert.equal(r.git('log', '-1', '--format=%s'), 'Update b');
  assert.equal(r.git('status', '--porcelain'), '?? new.txt');
});

test('stage selected lines from an editor writes only those lines to the index', async () => {
  r.write('a.txt', 'one\nTWO\nthree\nfour\n'); // committed: one TWO three
  const uri = mock.vscode.Uri.file(path.join(r.dir, 'a.txt'));
  const text = 'ONE\nTWO\nthree\nfour\n';
  const doc = { uri, getText: () => text, version: 2, isDirty: true, lineCount: 4, positionAt: () => new mock.vscode.Position(0, 0), save: async () => true };
  mock.vscode.workspace.textDocuments.push(doc);
  mock.vscode.window.activeTextEditor = { document: doc, selections: [new mock.vscode.Selection(new mock.vscode.Position(3, 0), new mock.vscode.Position(3, 2))] };
  await run('commitCorner.stageSelectedRanges');
  assert.equal(r.git('show', ':a.txt'), 'one\nTWO\nthree\nfour');
  // And unstage it again from the working-file coordinates.
  await run('commitCorner.unstageSelectedRanges');
  assert.equal(r.git('show', ':a.txt'), 'one\nTWO\nthree');
  mock.vscode.window.activeTextEditor = undefined;
  mock.vscode.workspace.textDocuments.length = 0;
});

test('branches: create, checkout with stash prompt, merge with conflict, abort', async () => {
  r.git('checkout', '-q', '--', 'a.txt');
  r.git('stash', '-q', '-u');
  mock.ui.answers.push('feature');
  await run('commitCorner.createBranch', { repoRoot: r.dir });
  assert.equal(r.git('branch', '--show-current'), 'feature');
  r.commit('feature edit', { 'b.txt': 'feature\n' });
  await run('commitCorner.checkout', { repoRoot: r.dir, ref: 'main', type: 'branch' });
  assert.equal(r.git('branch', '--show-current'), 'main');
  r.commit('main edit', { 'b.txt': 'main\n' });
  mock.ui.answers.push('Merge (no fast-forward)', undefined);
  await run('commitCorner.merge', { repoRoot: r.dir, ref: 'feature' });
  const state = await repo().refreshState();
  assert.equal(state.operation.kind, 'merge');
  assert.deepEqual(state.conflicts.map((c) => c.path), ['b.txt']);
  assert.ok(mock.ui.messages.some((m) => /stopped with conflicts/.test(m.msg)));
  await run('commitCorner.acceptTheirs', { repoRoot: r.dir, path: 'b.txt' });
  await run('commitCorner.continueOperation', { repoRoot: r.dir });
  assert.equal(r.read('b.txt'), 'feature\n');
  assert.equal(r.git('log', '-1', '--format=%p').split(' ').length, 2);
});

test('discarding an untracked file deletes it after confirmation', async () => {
  r.write('junk.txt', 'x');
  await api.manager.refresh(repo());
  mock.ui.answers.push(true);
  await run('commitCorner.discard', { repoRoot: r.dir, path: 'junk.txt', group: 'untracked' });
  assert.ok(!fs.existsSync(path.join(r.dir, 'junk.txt')));
});

test('compare view lists commits and files for a three-dot comparison', async () => {
  await api.manager.refresh(repo());
  const view = mock.treeViews.get('commitCorner.compare').provider;
  await view.setComparison(repo(), 'feature~1', 'feature');
  const roots = await view.getChildren();
  const labels = roots.map((n) => n.getTreeItem().label);
  assert.ok(labels.some((l) => /Commits only in feature \(1\)/.test(l)), labels.join(' | '));
  const files = roots.find((n) => /Files changed/.test(n.getTreeItem().label));
  const children = await files.getChildren();
  assert.deepEqual(children.map((c) => c.path), ['b.txt']);
});

test('branches view shows local branches with the current one first', async () => {
  const view = mock.treeViews.get('commitCorner.branches').provider;
  const roots = await view.getChildren();
  const local = roots.find((n) => n.getTreeItem().label === 'Local');
  const branches = await local.getChildren();
  assert.equal(branches[0].ref, 'main');
  assert.equal(branches[0].getTreeItem().contextValue, 'branch:current');
  assert.ok(branches.some((b) => b.ref === 'feature'));
});

test('file history view follows renames', async () => {
  r.git('mv', 'a.txt', 'renamed.txt');
  r.commit('rename a');
  const view = mock.treeViews.get('commitCorner.fileHistory').provider;
  view.setTarget({ repo: repo(), rel: 'renamed.txt' });
  const nodes = await view.getChildren();
  const subjects = nodes.map((n) => n.commit && n.commit.subject).filter(Boolean);
  assert.deepEqual(subjects.slice(0, 2), ['rename a', 'Change two']);
});

test('stash commands round-trip', async () => {
  r.write('b.txt', 'stash me\n');
  mock.ui.answers.push('my stash');
  await run('commitCorner.stash', { repoRoot: r.dir });
  assert.equal(r.read('b.txt'), 'feature\n');
  const [node] = await (await repositoryGroup('Stashes')).getChildren();
  assert.equal(node.stash.description, 'my stash');
  await run('commitCorner.stashPop', node);
  assert.equal(r.read('b.txt'), 'stash me\n');
  r.git('checkout', '-q', '--', 'b.txt');
});

test('interactive rebase plan becomes todo entries with message overrides', () => {
  const { planToTodo } = require('../src/vscode/webviews/rebaseEditor');
  const plan = [
    { type: 'commit', action: 'reword', sha: 'a'.repeat(40), subject: 'a', message: 'a', newMessage: 'A!' },
    { type: 'commit', action: 'pick', sha: 'b'.repeat(40), subject: 'b', message: 'b body' },
    { type: 'commit', action: 'squash', sha: 'c'.repeat(40), subject: 'c', message: 'c body' },
    { type: 'commit', action: 'fixup', sha: 'd'.repeat(40), subject: 'd', message: 'd' },
  ];
  const { entries, messages } = planToTodo(plan, true);
  assert.equal(entries[0].action, 'pick');
  assert.equal(messages.get(0), 'A!\n');
  assert.equal(messages.get(3), 'b body\n\nc body\n');
});

test('package.json menus only reference declared commands and submenus', () => {
  const declared = new Set(pkg.contributes.commands.map((c) => c.command));
  const submenus = new Set(pkg.contributes.submenus.map((s) => s.id));
  for (const [menu, items] of Object.entries(pkg.contributes.menus)) {
    for (const item of items) {
      if (item.submenu) assert.ok(submenus.has(item.submenu), `${menu}: ${item.submenu}`);
      else assert.ok(declared.has(item.command), `${menu}: ${item.command}`);
    }
  }
  // VS Code itself provides "<view id>.focus" for every contributed view.
  const focus = new Set(Object.values(pkg.contributes.views).flat().map((v) => `${v.id}.focus`));
  for (const kb of pkg.contributes.keybindings) assert.ok(declared.has(kb.command) || focus.has(kb.command), kb.command);
});

test('SCM multi-select passes resources spread as arguments: all of them are staged', async () => {
  r.write('m1.txt', '1\n');
  r.write('m2.txt', '2\n');
  r.write('m3.txt', '3\n');
  await api.manager.refresh(repo());
  const untracked = mock.sourceControls[0].groups[3].resourceStates.filter((x) => /^m\d\.txt$/.test(x.path));
  assert.equal(untracked.length, 3);
  await run('commitCorner.stage', ...untracked);
  await api.manager.refresh(repo());
  const staged = mock.sourceControls[0].groups[1].resourceStates.map((x) => x.path);
  for (const f of ['m1.txt', 'm2.txt', 'm3.txt']) assert.ok(staged.includes(f), `${f} staged`);
  await run('commitCorner.unstage', ...mock.sourceControls[0].groups[1].resourceStates);
  await api.manager.refresh(repo());
  assert.equal(mock.sourceControls[0].groups[1].resourceStates.length, 0);
  for (const f of ['m1.txt', 'm2.txt', 'm3.txt']) fs.rmSync(path.join(r.dir, f));
});

test('line staging with a CRLF editor and an LF index stages only the selected line', async () => {
  r.commit('crlf base', { 'crlf.txt': 'l1\nl2\nl3\nl4\n' });
  const uri = mock.vscode.Uri.file(path.join(r.dir, 'crlf.txt'));
  const text = 'l1\r\nl2\r\nNEW\r\nl3\r\nl4 edited\r\n';
  const doc = { uri, getText: () => text, version: 1, isDirty: true, lineCount: 5, encoding: 'utf8' };
  mock.vscode.workspace.textDocuments.push(doc);
  mock.vscode.window.activeTextEditor = { document: doc, selections: [new mock.vscode.Selection(new mock.vscode.Position(2, 0), new mock.vscode.Position(2, 3))] };
  await run('commitCorner.stageSelectedRanges');
  assert.equal(r.git('show', ':crlf.txt'), 'l1\nl2\nNEW\nl3\nl4');
  mock.vscode.window.activeTextEditor = undefined;
  mock.vscode.workspace.textDocuments.length = 0;
  r.git('reset', '-q', '--', 'crlf.txt');
});

test('line staging refuses non-UTF-8 documents instead of corrupting them', async () => {
  const uri = mock.vscode.Uri.file(path.join(r.dir, 'crlf.txt'));
  const doc = { uri, getText: () => 'x\n', version: 1, isDirty: true, lineCount: 1, encoding: 'windows1252' };
  mock.vscode.workspace.textDocuments.push(doc);
  mock.vscode.window.activeTextEditor = { document: doc, selections: [new mock.vscode.Selection(new mock.vscode.Position(0, 0), new mock.vscode.Position(0, 1))] };
  const before = mock.ui.messages.length;
  await run('commitCorner.stageSelectedRanges');
  const msg = mock.ui.messages.slice(before).find((m) => /UTF-8/.test(m.msg));
  assert.ok(msg, 'explains the refusal');
  mock.ui.messages.splice(before); // expected error, not a failure
  mock.vscode.window.activeTextEditor = undefined;
  mock.vscode.workspace.textDocuments.length = 0;
});

test('explorer decorations mark changed files when the built-in Git is off', async () => {
  mock.configValues.set('explorerDecorations', 'always');
  r.write('b.txt', 'decorated\n');
  r.write('brand-new.txt', 'n\n');
  await api.manager.refresh(repo());
  const { FileDecorations } = require('../src/vscode/decorations');
  const deco = new FileDecorations(api.manager);
  const m = deco.provideFileDecoration(mock.vscode.Uri.file(path.join(r.dir, 'b.txt')));
  const u = deco.provideFileDecoration(mock.vscode.Uri.file(path.join(r.dir, 'brand-new.txt')));
  assert.equal(m.badge, 'M');
  assert.equal(u.badge, 'U');
  assert.equal(deco.provideFileDecoration(mock.vscode.Uri.file(path.join(r.dir, 'renamed.txt'))), undefined);
  deco.dispose();
  mock.configValues.delete('explorerDecorations');
  r.git('checkout', '-q', '--', 'b.txt');
  fs.rmSync(path.join(r.dir, 'brand-new.txt'));
});

test('squash into parent from a commit node rewrites history in one step', async () => {
  r.commit('part 1', { 'p.txt': '1\n' });
  const sha = r.commit('part 2', { 'p.txt': '2\n' });
  await api.manager.refresh(repo());
  await run('commitCorner.squashIntoParent', { repoRoot: r.dir, sha });
  assert.equal(r.git('log', '-1', '--format=%B'), 'part 1\n\npart 2');
  assert.equal(r.read('p.txt'), '2\n');
});

test('open all changes of a group uses the multi-diff editor', async () => {
  r.write('b.txt', 'again\n');
  await api.manager.refresh(repo());
  const group = mock.sourceControls[0].groups[2];
  await run('commitCorner.openAllChanges', group);
  const call = mock.executed.filter((e) => e.id === 'vscode.changes').pop();
  assert.ok(call, 'vscode.changes was called');
  assert.equal(call.args[1].length, group.resourceStates.length);
  r.git('checkout', '-q', '--', 'b.txt');
});

test('fixup: staged changes are folded into an older commit (autosquash)', async () => {
  const target = r.commit('feature A', { 'fa.txt': 'a\n' });
  r.commit('feature B', { 'fb.txt': 'b\n' });
  r.write('fa.txt', 'a fixed\n');
  r.git('add', 'fa.txt');
  await api.manager.refresh(repo());
  mock.ui.answers.push(true); // confirm
  await run('commitCorner.fixupStagedInto', { repoRoot: r.dir, sha: target });
  assert.deepEqual(r.git('log', '--format=%s', '-2').split('\n'), ['feature B', 'feature A']);
  assert.equal(r.git('show', 'HEAD~1:fa.txt'), 'a fixed');
  assert.equal(r.git('status', '--porcelain'), '');
});

test('squash selected (non-adjacent) commits from a multi-selection', async () => {
  const a = r.commit('s1', { 's1.txt': '1\n' });
  r.commit('keep', { 'k.txt': 'k\n' });
  const c = r.commit('s2', { 's2.txt': '2\n' });
  await api.manager.refresh(repo());
  mock.ui.answers.push('Squashed s1+s2');
  await run('commitCorner.squashSelected', { repoRoot: r.dir, sha: c }, [{ repoRoot: r.dir, sha: a, commit: {} }, { repoRoot: r.dir, sha: c, commit: {} }]);
  assert.deepEqual(r.git('log', '--format=%s', '-2').split('\n'), ['keep', 'Squashed s1+s2']);
  assert.equal(r.git('show', '--name-only', '--format=', 'HEAD~1').split('\n').sort().join(','), 's1.txt,s2.txt');
});

test('show commit with a tree multi-selection opens the combined diff', async () => {
  const log = r.git('log', '--format=%H', '-2').split('\n');
  const nodes = log.map((sha) => ({ repoRoot: r.dir, sha, commit: {} }));
  await run('commitCorner.showCommit', nodes[0], nodes);
  const call = mock.executed.filter((e) => e.id === 'vscode.changes').pop();
  assert.match(call.args[0], /2 commits/);
});

test('the ref picker prefers a matching branch over the typed text', async () => {
  const { pickRef } = require('../src/vscode/pickers');
  mock.ui.answers.push((kind) => (kind === 'quickPick' ? 'feature' : undefined));
  const picked = await pickRef(repo());
  assert.equal(picked, 'feature');
});

test('stage all on an empty Changes group stages nothing (and never everything)', async () => {
  r.write('stray-untracked.txt', 'u\n');
  await api.manager.refresh(repo());
  const unstagedGroup = mock.sourceControls[0].groups[2];
  assert.equal(unstagedGroup.resourceStates.length, 0);
  await run('commitCorner.stageAll', unstagedGroup);
  assert.equal(r.git('diff', '--cached', '--name-only'), '');
  fs.rmSync(path.join(r.dir, 'stray-untracked.txt'));
});

test('commit selected keeps a staged rename together', async () => {
  r.commit('to rename', { 'old-name.txt': 'content\n' });
  r.git('mv', 'old-name.txt', 'new-name.txt');
  await api.manager.refresh(repo());
  await api.scm.get(repo()).update(); // the provider updates after the refresh: wait for it
  const staged = mock.sourceControls[0].groups[1].resourceStates.find((x) => x.path === 'new-name.txt');
  mock.sourceControls[0].inputBox.value = 'rename it';
  assert.ok(staged, 'the staged rename is listed');
  await run('commitCorner.commitSelected', staged);
  assert.equal(r.git('show', '--name-status', '--format=', '-M', 'HEAD').split('\t')[0].startsWith('R'), true);
  assert.equal(r.git('diff', '--cached', '--name-only'), '');
});

test('the status limit truncates Source Control and warns once', async () => {
  mock.configValues.set('statusLimit', 3);
  for (let i = 0; i < 6; i++) r.write(`lim-${i}.txt`, `${i}\n`);
  const before = mock.ui.messages.length;
  await api.manager.refresh(repo());
  const shown = mock.sourceControls[0].groups.reduce((n, g) => n + g.resourceStates.length, 0);
  assert.equal(shown, 3);
  assert.ok(mock.ui.messages.slice(before).some((m) => /shows the first 3/.test(m.msg)));
  mock.configValues.delete('statusLimit');
  for (let i = 0; i < 6; i++) fs.rmSync(path.join(r.dir, `lim-${i}.txt`));
  await api.manager.refresh(repo());
});

test('committing to a protected branch asks first', async () => {
  mock.configValues.set('protectedBranches', ['ma*']);
  r.write('b.txt', 'protected change\n');
  r.git('add', 'b.txt');
  await api.manager.refresh(repo());
  const head = r.git('rev-parse', 'HEAD');
  mock.sourceControls[0].inputBox.value = 'should not land';
  mock.ui.answers.push(undefined); // dismiss the warning
  await run('commitCorner.commit', { repoRoot: r.dir });
  assert.equal(r.git('rev-parse', 'HEAD'), head);
  mock.ui.answers.push('Commit Anyway');
  await run('commitCorner.commit', { repoRoot: r.dir });
  assert.equal(r.git('log', '-1', '--format=%s'), 'should not land');
  mock.configValues.delete('protectedBranches');
});

test('continuing a rebase keeps the commit message when the box holds an unrelated draft', async () => {
  r.git('checkout', '-q', '-b', 'cc-topic');
  r.commit('feature: important message', { 'rb.txt': 'topic\n' });
  r.git('checkout', '-q', 'main');
  r.commit('main side', { 'rb.txt': 'main\n' });
  r.git('checkout', '-q', 'cc-topic');
  await repo().rebase('main').catch(() => {});
  r.write('rb.txt', 'resolved\n');
  r.git('add', 'rb.txt');
  const sc = mock.sourceControls[0];
  sc.inputBox.value = 'unrelated draft I was typing earlier';
  await api.manager.refresh(repo());
  await run('commitCorner.continueOperation', { repoRoot: r.dir });
  assert.equal(r.git('log', '-1', '--format=%s'), 'feature: important message');
  r.git('checkout', '-q', 'main');
  sc.inputBox.value = '';
});

test('Commit from the graph during a rebase continues it with the message typed there', async () => {
  r.git('checkout', '-q', '-b', 'gr-topic');
  r.commit('gr: old message', { 'gr.txt': 'topic\n' });
  r.git('checkout', '-q', 'main');
  r.commit('gr main side', { 'gr.txt': 'main\n' });
  r.git('checkout', '-q', 'gr-topic');
  await repo().rebase('main').catch(() => {});
  r.write('gr.txt', 'resolved\n');
  r.git('add', 'gr.txt');
  await api.manager.refresh(repo());
  await run('commitCorner.commit', { repoRoot: r.dir, message: 'gr: message from the graph' });
  assert.equal(r.git('log', '-1', '--format=%s'), 'gr: message from the graph');
  assert.equal((await repo().refreshState()).operation, undefined, 'the rebase went on to its end');
  r.git('checkout', '-q', 'main');
});

test('a merge aborted in a terminal takes its untouched message out of Source Control', async () => {
  r.git('checkout', '-q', '-b', 'ab-topic');
  r.commit('ab topic', { 'ab.txt': 'topic\n' });
  r.git('checkout', '-q', 'main');
  r.commit('ab main', { 'ab.txt': 'main\n' });
  await repo().merge('ab-topic').catch(() => {});
  const sc = mock.sourceControls[0];
  try {
    await api.manager.refresh(repo());
    await api.scm.get(repo()).update();
    assert.match(sc.inputBox.value, /Merge branch 'ab-topic'/);
  } finally {
    r.git('merge', '--abort');
  }
  await api.manager.refresh(repo());
  await api.scm.get(repo()).update();
  assert.equal(sc.inputBox.value, '');
});

test('saving a conflicted file without markers offers to mark it resolved', async () => {
  r.git('checkout', '-q', '-b', 'cf-topic');
  r.commit('cf topic', { 'cf.txt': 'topic\n' });
  r.git('checkout', '-q', 'main');
  r.commit('cf main', { 'cf.txt': 'main\n' });
  await repo().merge('cf-topic').catch(() => {});
  await api.manager.refresh(repo());
  r.write('cf.txt', 'merged by hand\n');
  mock.ui.answers.push('Stage (Resolved)');
  const doc = { uri: mock.vscode.Uri.file(path.join(r.dir, 'cf.txt')), getText: () => 'merged by hand\n' };
  mock.events.onDidSaveTextDocument.fire(doc);
  await new Promise((res) => setTimeout(res, 100));
  const s = await repo().refreshState();
  assert.equal(s.conflicts.length, 0);
  await run('commitCorner.continueOperation', { repoRoot: r.dir });
  assert.equal(r.git('log', '-1', '--format=%p').split(' ').length, 2);
});

test('a repository above the workspace folder is opened only after asking', async () => {
  const parent = { root: path.dirname(r.dir), displayRoot: path.dirname(r.dir) };
  mock.ui.answers.push('Never for This Repository');
  assert.equal(await api.manager.allowParentRepository(parent), false, 'not opened while asking');
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(await api.manager.allowParentRepository(parent), false, 'remembered');
  mock.configValues.set('openRepositoryInParentFolders', 'always');
  assert.equal(await api.manager.allowParentRepository(parent), true);
  mock.configValues.delete('openRepositoryInParentFolders');
  assert.equal(await api.manager.allowParentRepository(repo()), true, 'the workspace repository itself is fine');
});

test('credentials in URLs are redacted from the git log', () => {
  const { redact } = require('../src/extension');
  assert.equal(redact('git clone https://me:ghp_TOKEN@github.com/o/r.git'), 'git clone https://***@github.com/o/r.git');
  assert.equal(redact('git push origin main'), 'git push origin main');
});

test('graph paging keeps the first-parent filter (and every other history option)', async () => {
  const { GraphPanel } = require('../src/vscode/webviews/graphPanel');
  const { GraphLayout } = require('../src/git/graph');
  const calls = [];
  const fake = {
    search: undefined, filtered: false, layout: new GraphLayout(), loaded: 5, limit: 5, loadToken: 0,
    filter: { kind: 'firstParent' },
    revs: () => ['HEAD'],
    repo: { log: async (o) => (calls.push(o), []) },
    post() {},
    signature: async () => 'tips-1',
    lastSignature: 'tips-1',
  };
  fake.logOptions = GraphPanel.prototype.logOptions.bind(fake);
  await GraphPanel.prototype.loadMore.call(fake);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].firstParent, true);
  assert.equal(calls[0].skip, 5);
  assert.deepEqual(calls[0].revs, ['HEAD']);
  assert.equal(calls[0].topo, true);
  // Refs moved since the list was loaded (an agent committed): no --skip page, a full reload.
  let reloaded;
  fake.lastSignature = 'tips-0';
  fake.load = async (o) => (reloaded = o);
  await GraphPanel.prototype.loadMore.call(fake);
  assert.equal(calls.length, 1, 'no paged request');
  assert.deepEqual(reloaded, { keepScroll: true });
  assert.ok(fake.limit > 5);
});

test('graph context menus act on the selection the webview sends along', () => {
  const { GraphPanel } = require('../src/vscode/webviews/graphPanel');
  const [a, b, c] = ['a', 'b', 'c'].map((x) => x.repeat(40));
  const fake = { repo: { root: r.dir }, selection: ['old'] };
  const node = GraphPanel.prototype.nodeFromContext.call(fake, { sha: b, selection: [a, b] });
  assert.deepEqual(node.shas, [a, b]);
  const single = GraphPanel.prototype.nodeFromContext.call(fake, { sha: c, selection: [a, b] });
  assert.deepEqual(single.shas, [c]);
  // Menu data comes from the page: only SHAs and plain ref names are taken.
  const hostile = GraphPanel.prototype.nodeFromContext.call(fake, { sha: '--all', ref: '--output=/tmp/x', refType: 'evil', selection: [a, '-x'] });
  assert.deepEqual(hostile, { repoRoot: r.dir });
});

test('restored graph state and reveal requests never hand git an option', () => {
  const { GraphPanel } = require('../src/vscode/webviews/graphPanel');
  const fake = { filter: { kind: 'all' }, includeRefs: [] };
  GraphPanel.prototype.applyView.call(fake, { filter: { kind: 'ref', ref: '--output=/tmp/x' } });
  assert.deepEqual(fake.filter, { kind: 'all' }, 'refused like a message');
  fake.filter = { kind: 'ref', ref: '--output=/tmp/x' }; // however it got there
  assert.throws(() => GraphPanel.prototype.revs.call(fake), /Refusing/);
  fake.filter = { kind: 'current' };
  fake.includeRefs = ['refs/commit-corner/pr/origin/7/head', '--output=/tmp/x', 'a b'];
  assert.deepEqual(GraphPanel.prototype.revs.call(fake), ['HEAD', 'refs/commit-corner/pr/origin/7/head']);
});

test('Delete in the Branches view deletes the focused branch, never the current one', async () => {
  r.git('branch', 'kb-delete-me');
  const tree = mock.treeViews.get('commitCorner.branches');
  const roots = await tree.provider.getChildren();
  const local = roots.find((n) => n.getTreeItem().label === 'Local');
  const node = (await local.getChildren()).find((b) => b.ref === 'kb-delete-me');
  tree.selection = [node];
  mock.ui.answers.push('Delete');
  await run('commitCorner.view.deleteItem', 'branches');
  assert.ok(!r.git('branch', '--list', 'kb-delete-me'), 'deleted');
  const current = (await local.getChildren()).find((b) => b.current);
  tree.selection = [current];
  await run('commitCorner.view.deleteItem', 'branches'); // refused quietly: it is checked out
  assert.ok(r.git('branch', '--list', current.ref));
  tree.selection = [];
});

test('commit rows show an avatar, the age and the change size; tooltips link to actions', async () => {
  const { CommitNode } = require('../src/vscode/views/nodes');
  const [c] = await repo().log({ revs: ['HEAD'], maxCount: 1, stats: true });
  const item = new CommitNode(repo(), c).getTreeItem();
  assert.match(item.description, /\+\d+ −\d+|no changes/);
  assert.ok(item.iconPath && item.iconPath.fsPath && item.iconPath.fsPath.endsWith('.svg'), 'initials avatar file');
  assert.match(fs.readFileSync(item.iconPath.fsPath, 'utf8'), /<svg[\s\S]*<text[^>]*>[A-Z?]{1,2}<\/text>/);
  assert.match(item.tooltip.value, /Show Changes/);
  assert.deepEqual(item.tooltip.isTrusted.enabledCommands.includes('commitCorner.showCommit'), true);
});

test('the Worktrees view shows state, upstream and the checked-out commit', async () => {
  const roots = await mock.treeViews.get('commitCorner.worktrees').provider.getChildren();
  const current = roots.find((n) => n.worktree && n.worktree.isCurrent);
  const item = current.getTreeItem();
  assert.match(item.description, /this window/);
  assert.match(item.description, /clean|change/);
  const children = await current.getChildren();
  assert.ok(children.some((n) => n.commit), 'the HEAD commit');
  assert.ok(children.some((n) => /Working tree:/.test(n.message)));
});

test('GitHub credential prompts are answered from the VS Code GitHub session', async () => {
  const { gitPromptKind, answerGitPrompt } = require('../src/vscode/github/auth');
  assert.equal(gitPromptKind("Username for 'https://github.com': "), 'username');
  assert.equal(gitPromptKind("Password for 'https://octo@github.com': "), 'password');
  assert.equal(gitPromptKind("Password for 'https://gitlab.com': "), undefined, 'GitHub.com only');
  assert.equal(gitPromptKind("Enter passphrase for key '/home/u/.ssh/id_ed25519': "), undefined);
  const session = { accessToken: 'gho_token', account: { label: 'octo' } };
  const asked = [];
  const getSession = async (quiet) => (asked.push(quiet), session);
  assert.equal(await answerGitPrompt("Username for 'https://github.com': ", { getSession, helpersOff: true }), 'octo');
  assert.equal(await answerGitPrompt("Password for 'https://octo@github.com': ", { getSession, quiet: true, helpersOff: true }), 'gho_token');
  assert.deepEqual(asked, [false, true]);
  assert.equal(await answerGitPrompt("Password for 'https://example.com': ", { getSession, helpersOff: true }), undefined);
  assert.equal(await answerGitPrompt("Password for 'https://github.com': ", { getSession, ssh: true, helpersOff: true }), undefined, 'never for ssh prompts');
  assert.equal(await answerGitPrompt("Username for 'https://github.com': ", { getSession: async () => undefined, helpersOff: true }), undefined, 'no session: ask the user');
});

test('tree views show commits at once and fill in their stats afterwards', async () => {
  const tree = mock.treeViews.get('commitCorner.branches');
  const roots = await tree.provider.getChildren();
  const local = roots.find((n) => n.getTreeItem().label === 'Local');
  const branch = (await local.getChildren()).find((b) => b.ref === 'main');
  repo().statsCache = new Map();
  const changed = new Promise((resolve) => {
    const sub = tree.provider.onDidChangeTreeData((nodes) => {
      if (Array.isArray(nodes) && nodes.some((n) => n.commit && n.commit.stats)) {
        sub.dispose();
        resolve(nodes);
      }
    });
  });
  const commits = await tree.provider.getChildren(branch);
  assert.ok(commits.length > 0);
  const updated = await changed;
  assert.ok(updated.every((n) => n.commit.stats));
  assert.match(updated[0].getTreeItem().description, /\+\d+ −\d+|no changes/);
});

test('graph webview messages are validated before they reach git', async () => {
  const { GraphPanel } = require('../src/vscode/webviews/graphPanel');
  const fake = { filter: { kind: 'all' }, includeRefs: [], search: undefined };
  assert.equal(GraphPanel.prototype.applyView.call(fake, { filter: { kind: 'ref', ref: '--output=/tmp/x' } }), false);
  assert.equal(GraphPanel.prototype.applyView.call(fake, { filter: { kind: 'evil' } }), false);
  assert.deepEqual(fake.filter, { kind: 'all' });
  assert.equal(GraphPanel.prototype.applyView.call(fake, { filter: { kind: 'ref', ref: 'feature' } }), true);
  assert.deepEqual(fake.filter, { kind: 'ref', ref: 'feature' });
  assert.equal(GraphPanel.prototype.applyView.call(fake, { search: { mode: 'shell', text: 'x' } }), false);
});

test('a history rewrite can be undone in one step', async () => {
  r.git('checkout', '-q', 'main');
  r.commit('undo base', { 'u.txt': '1\n' });
  r.commit('undo me', { 'u.txt': '2\n' });
  const before = r.git('rev-parse', 'HEAD');
  mock.ui.answers.push('Drop Commit');
  mock.ui.answers.push(undefined); // the "Undo / Show in Graph" notification: no choice yet
  await run('commitCorner.dropCommit', { repoRoot: r.dir, sha: before });
  assert.notEqual(r.git('rev-parse', 'HEAD'), before, 'dropped');
  await run('commitCorner.undoRewrite', { repoRoot: r.dir });
  assert.equal(r.git('rev-parse', 'HEAD'), before, 'back where it was');
});

test('commit lists get Today / Yesterday / … separators', () => {
  const { CommitNode, withTimeSeparators, TimeSeparatorNode } = require('../src/vscode/views/nodes');
  const now = Date.now();
  const c = (sha, ageDays) => new CommitNode(repo(), { sha: sha.repeat(40), parents: [], authorName: 'A', authorEmail: 'a@x', authorDate: now - ageDays * 864e5, refs: [], subject: sha });
  const out = withTimeSeparators([c('a', 0), c('b', 0), c('c', 3), c('d', 400)]);
  const seps = out.filter((n) => n instanceof TimeSeparatorNode);
  assert.deepEqual(seps.map((n) => [n.label, n.count]), [['Today', 2], ['This week', 1], ['Older', 1]]);
  assert.equal(out.length, 7);
  assert.equal(withTimeSeparators([c('e', 0)]).length, 1, 'a single commit gets no separator');
});

test('pull requests show GitHub API metadata (title, author, state, reviews, checks) when available', async () => {
  const api = require('../src/vscode/github');
  const saved = { list: api.listPullRequests, status: api.pullRequestStatus };
  r.git('remote', 'add', 'gh', 'https://github.com/octo/demo.git');
  const now = Date.now();
  api.listPullRequests = async () => ({ more: false, prs: [
    { number: 7, title: 'Add sidebar graph', state: 'open', author: 'octo', createdAt: now - 864e5, updatedAt: now - 36e5, headSha: 'a'.repeat(40), headRef: 'feature', headOwner: 'octo', baseRef: 'main', labels: ['ui'], body: '**do not render** <b>me</b>', url: '' },
    { number: 5, title: 'Old fix', state: 'merged', author: 'ada', createdAt: now - 90 * 864e5, updatedAt: now - 60 * 864e5, headSha: 'b'.repeat(40), headRef: 'fix', headOwner: 'ada', baseRef: 'main', labels: [], body: '', url: '' },
  ] });
  api.pullRequestStatus = async () => ({ approvedBy: ['ada'], changesRequestedBy: [], checks: [{ name: 'ci', state: 'success' }, { name: 'lint', state: 'failure' }] });
  try {
    const view = mock.treeViews.get('commitCorner.pullRequests').provider;
    const roots = await view.getChildren();
    const prs = roots.filter((n) => n.number);
    assert.deepEqual(prs.map((n) => n.number), [7, 5]);
    const item = prs[0].getTreeItem();
    assert.match(item.label, /#7 {2}Add sidebar graph/);
    assert.match(item.description, /octo/);
    assert.equal(item.iconPath.id, 'git-pull-request');
    assert.equal(prs[1].getTreeItem().iconPath.id, 'git-merge');
    assert.ok(roots.some((n) => n.label === 'Today'), 'time separators by last update');
    assert.ok(item.tooltip.value.includes('\\*\\*do not render\\*\\* \\<b\\>me\\</b\\>'), 'the description is plain text, never markdown or HTML');
    const status = await prs[0].statusNodes();
    assert.deepEqual(status.map((n) => n.message), ['Approved by ada', 'Checks: 1 passed, 1 failed (lint)']);
  } finally {
    api.listPullRequests = saved.list;
    api.pullRequestStatus = saved.status;
    r.git('remote', 'remove', 'gh');
  }
});

test('GitHub API data is type-checked before use', () => {
  const api = { ...require('../src/vscode/github'), pullSummary: require('../src/vscode/github/pulls').pullSummary };
  assert.equal(api.pullSummary({ number: '7', head: { sha: 'a'.repeat(40) } }), undefined, 'number must be a number');
  assert.equal(api.pullSummary({ number: 7, head: { sha: '--upload-pack=x' } }).headSha, undefined);
  assert.equal(api.slugOf('https://github.com/../x'), undefined);
  assert.deepEqual(api.slugOf('https://github.com/octo/demo'), { owner: 'octo', repo: 'demo' });
});

test('a repository outside the workspace is opened only after asking', async () => {
  const os = require('os');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-outside-'));
  require('child_process').execFileSync('git', ['init', '-q', outside]);
  fs.writeFileSync(path.join(outside, 'README.md'), 'hi\n');
  const before = api.manager.repositories.length;
  mock.ui.answers.push(undefined); // the question is dismissed
  await api.manager.discoverForUri(mock.vscode.Uri.file(path.join(outside, 'README.md')));
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(api.manager.repositories.length, before, 'not opened without consent');
  assert.ok(mock.ui.messages.some((m) => /outside this workspace/.test(m.msg)), 'asked');
  fs.rmSync(outside, { recursive: true, force: true });
});

test('a symlink committed in the workspace does not open the repository it points to without asking', { skip: process.platform === 'win32' }, async (t) => {
  const os = require('os');
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-other-'));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  require('child_process').execFileSync('git', ['init', '-q', other]);
  const marker = path.join(other, 'RAN');
  require('child_process').execFileSync('git', ['config', 'core.fsmonitor', `touch '${marker}'; false`], { cwd: other });
  fs.writeFileSync(path.join(other, 'f.txt'), 'x\n');
  const link = path.join(r.dir, 'link-to-other');
  fs.symlinkSync(other, link);
  t.after(() => fs.rmSync(link, { force: true }));
  const before = api.manager.repositories.length;
  mock.ui.answers.push(undefined); // the question is dismissed
  await api.manager.discoverForUri(mock.vscode.Uri.file(path.join(link, 'f.txt')));
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(api.manager.repositories.length, before, 'not opened without consent');
  assert.equal(fs.existsSync(marker), false, 'no git ran there');
});

test('comparing a branch with the working tree shows only what HEAD did since it left it', async () => {
  r.git('checkout', '-q', '-b', 'cmp-base');
  r.commit('cmp base', { 'cmp.txt': 'base\n' });
  r.git('checkout', '-q', '-b', 'cmp-agent');
  r.commit('agent work', { 'agent.txt': 'a\n' });
  r.git('checkout', '-q', 'cmp-base');
  r.commit('base moved on', { 'later.txt': 'l\n' });
  r.git('checkout', '-q', 'cmp-agent');
  r.write('agent.txt', 'a\nuncommitted\n');
  await api.manager.refresh(repo());
  const view = mock.treeViews.get('commitCorner.compare').provider;
  await run('commitCorner.compareWithWorkingTree', { repoRoot: r.dir, ref: 'cmp-base' });
  const { files } = await view.files();
  assert.deepEqual(files.map((f) => f.path).sort(), ['agent.txt'], 'the base branch\'s later work is not mixed in');
  view.clear();
  r.git('checkout', '-q', '--', 'agent.txt');
  r.git('checkout', '-q', 'main');
  await api.manager.refresh(repo());
});

test('a dismissed confirmation leaves everything as it was (discard, discard all, delete untracked)', async () => {
  r.write('keep-untracked.txt', 'keep\n');
  const tracked = r.git('ls-files').split('\n')[0];
  const before = r.read(tracked);
  r.write(tracked, `${before}changed\n`);
  await api.manager.refresh(repo());
  try {
    mock.ui.answers.push(undefined); // the dialog closed without a choice
    await run('commitCorner.discard', { repoRoot: r.dir, path: 'keep-untracked.txt', group: 'untracked' });
    assert.ok(fs.existsSync(path.join(r.dir, 'keep-untracked.txt')), 'discard cancelled: the file is still there');
    mock.ui.answers.push(undefined);
    await run('commitCorner.discardAll', { repoRoot: r.dir });
    assert.equal(r.read(tracked), `${before}changed\n`, 'discard all cancelled: the change is still there');
    mock.ui.answers.push(undefined);
    await run('commitCorner.cleanAll', { repoRoot: r.dir });
    assert.ok(fs.existsSync(path.join(r.dir, 'keep-untracked.txt')), 'delete untracked cancelled: the file is still there');
  } finally {
    fs.rmSync(path.join(r.dir, 'keep-untracked.txt'), { force: true });
    r.git('checkout', '--', tracked);
    await api.manager.refresh(repo());
  }
});

test('an agent\'s worktree inside the repository survives Delete Untracked, Discard and Discard All', async () => {
  const wt = path.join(r.dir, '.claude', 'worktrees', 'x');
  r.git('worktree', 'add', '-q', '-b', 'agent-x', wt);
  fs.writeFileSync(path.join(wt, 'agent-work.txt'), 'uncommitted agent work\n');
  r.write('intent.txt', 'intent content\n');
  r.git('add', '-N', 'intent.txt');
  r.write('junk-untracked.txt', 'junk\n');
  await api.manager.refresh(repo());
  try {
    mock.ui.answers.push(true);
    await run('commitCorner.cleanAll', { repoRoot: r.dir });
    assert.ok(!fs.existsSync(path.join(r.dir, 'junk-untracked.txt')), 'a plain untracked file is deleted');
    assert.ok(fs.existsSync(path.join(wt, '.git')) && fs.existsSync(path.join(wt, 'agent-work.txt')), 'the worktree is kept');
    await api.manager.refresh(repo());
    await run('commitCorner.discard', { repoRoot: r.dir, path: '.claude/worktrees/x/', group: 'untracked' });
    assert.ok(fs.existsSync(path.join(wt, 'agent-work.txt')), 'discard refuses the worktree');
    const tracked = r.git('ls-files').split('\n').find((f) => f !== 'intent.txt');
    const was = r.read(tracked);
    r.write(tracked, `${was}to discard\n`);
    await api.manager.refresh(repo());
    mock.ui.answers.push(true);
    await run('commitCorner.discardAll', { repoRoot: r.dir });
    assert.equal(r.read(tracked), was, 'the tracked change is discarded');
    assert.equal(r.read('intent.txt'), 'intent content\n', 'an intent-to-add file keeps its content');
  } finally {
    r.git('worktree', 'remove', '--force', wt);
    r.git('branch', '-D', 'agent-x');
    r.git('rm', '-q', '--cached', 'intent.txt');
    fs.rmSync(path.join(r.dir, 'intent.txt'), { force: true });
    fs.rmSync(path.join(r.dir, '.claude'), { recursive: true, force: true });
    await api.manager.refresh(repo());
  }
});

test('Discard on a folder row never deletes a repository created in it after the row was listed', async () => {
  mock.configValues.set('untrackedFiles', 'normal');
  r.write('scratch/notes.txt', 'n\n');
  try {
    await api.manager.refresh(repo());
    assert.ok(repo().state.untracked.some((e) => e.path === 'scratch/'), 'the row is "scratch/"');
    r.git('init', '-q', path.join(r.dir, 'scratch', 'agent'));
    mock.ui.answers.push(true, true); // would be the answers if it asked
    await run('commitCorner.discard', { repoRoot: r.dir, path: 'scratch/' });
    mock.ui.answers.length = 0;
    assert.ok(fs.existsSync(path.join(r.dir, 'scratch', 'agent', '.git')), 'the new repository is kept');
    assert.ok(mock.ui.messages.some((m) => m.level === 'warning' && /"scratch\/" is or holds a repository/.test(m.msg)), 'and you are told why');
  } finally {
    mock.configValues.delete('untrackedFiles');
    fs.rmSync(path.join(r.dir, 'scratch'), { recursive: true, force: true });
    await api.manager.refresh(repo());
  }
});

test('a pull request\'s files have a dot until opened; Mark as Not Viewed brings it back', async (t) => {
  // A remote that publishes pull request #7 the way GitHub does (its head and test merge).
  const remote = path.join(require('os').tmpdir(), `cc-pr-remote-${process.pid}-${Date.now()}.git`);
  t.after(() => fs.rmSync(remote, { recursive: true, force: true }));
  r.git('init', '-q', '--bare', remote);
  const index = path.join(require('os').tmpdir(), `cc-pr-index-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const plumb = (args, input) => require('child_process').execFileSync('git', args, { cwd: r.dir, env, input, encoding: 'utf8' }).trim();
  const head = r.git('rev-parse', 'HEAD');
  // Two commits: the first deletes a file the base has and adds pr/one.txt, the second pr/two.txt.
  const add = (p, text) => plumb(['update-index', '--add', '--cacheinfo', `100644,${plumb(['hash-object', '-w', '--stdin'], text)},${p}`]);
  const gone = r.git('ls-tree', '--name-only', 'HEAD').split('\n').find((n) => /\.txt$/.test(n));
  plumb(['read-tree', head]);
  plumb(['update-index', '--force-remove', gone]);
  add('pr/one.txt', 'one\n');
  const first = plumb(['commit-tree', plumb(['write-tree']), '-p', head, '-m', 'PR work 1']);
  add('pr/two.txt', 'two\n');
  const tree = plumb(['write-tree']);
  const pr = plumb(['commit-tree', tree, '-p', first, '-m', 'PR work 2']);
  const testMerge = plumb(['commit-tree', tree, '-p', head, '-p', pr, '-m', 'Merge']);
  fs.rmSync(index, { force: true });
  r.git('push', '-q', remote, `${head}:refs/heads/main`, `${pr}:refs/pull/7/head`, `${testMerge}:refs/pull/7/merge`);
  r.git('remote', 'add', 'prs', remote);
  t.after(() => r.git('remote', 'remove', 'prs'));
  const view = mock.treeViews.get('commitCorner.pullRequests').provider;
  const fired = [];
  const sub = view.onDidChangeTreeData((e) => fired.push(e));
  t.after(() => sub.dispose());
  const roots = await view.getChildren();
  const prNode = roots.flatMap((n) => (n.number ? [n] : [])).find((n) => n.number === 7) || (await Promise.all(roots.filter((n) => n.getChildren && !n.number).map((g) => view.getChildren(g)))).flat().find((n) => n.number === 7);
  assert.ok(prNode, `pull request #7 is listed: ${roots.map((n) => n.getTreeItem().label).join(' | ')}`);
  const group = (await view.getChildren(prNode)).find((n) => /Files changed/.test(n.label));
  const top = await view.getChildren(group);
  const folder = top.find((n) => n.name === 'pr');
  const deleted = top.find((n) => n.path === gone);
  const files = await view.getChildren(folder);
  assert.deepEqual(files.map((f) => f.path), ['pr/one.txt', 'pr/two.txt']);
  const item = files[0].getTreeItem();
  assert.equal(item.checkboxState, undefined, 'no checkbox');
  assert.equal(item.contextValue, 'file:pr:new');
  assert.match(String(item.resourceUri.query), /^vs=/);
  // Opening it (its row's command) marks it viewed.
  await run(item.command.command, ...item.command.arguments);
  assert.equal(files[0].getTreeItem().contextValue, 'file:pr:viewed');
  assert.equal(group.getTreeItem().description, '1/3 viewed');
  assert.match(files[0].getTreeItem().tooltip, /✓ Viewed/);
  // Its count is redrawn once VS Code has stopped loading rows (TreeProvider.redraw).
  await new Promise((res) => setTimeout(res, 400));
  assert.ok(fired.some((e) => Array.isArray(e) && e.includes(group)), 'the Files changed row is redrawn');
  await run('commitCorner.markCommitFileUnviewed', files[0]);
  assert.equal(files[0].getTreeItem().contextValue, 'file:pr:new');
  // Next Unviewed File in that diff: the next file of the list not viewed yet, in the order shown.
  const viewed = require('../src/vscode/viewed');
  const shown = viewed.listOfShown({ uris: files[0].openUris(), diff: true });
  assert.equal(shown.list.label, 'pull request #7');
  assert.deepEqual(shown.list.rows.map((n) => n.path), ['pr/one.txt', 'pr/two.txt', gone]);
  const next = viewed.nextUnviewedRow(shown.scope, shown.list, shown.at);
  assert.equal(next.path, 'pr/two.txt');
  await next.open();
  assert.equal(files[1].getTreeItem().contextValue, 'file:pr:viewed');
  // Several selected files, or a folder: all of them at once (both viewed first, so marking only
  // the one right-clicked would show).
  await run('commitCorner.markCommitFileViewed', files[0]);
  assert.equal(group.getTreeItem().description, '2/3 viewed');
  await run('commitCorner.markCommitFileUnviewed', files[1], [files[0], files[1]]);
  assert.equal(files[0].getTreeItem().contextValue, 'file:pr:new');
  assert.equal(files[1].getTreeItem().contextValue, 'file:pr:new');
  assert.equal(group.getTreeItem().description, undefined, 'none viewed');
  assert.equal(folder.getTreeItem().contextValue, 'folder:marks');
  // Each row knows the one above it (Next Unviewed File selects the file it opens in the tree).
  assert.equal(view.getParent(files[0]), folder);
  assert.equal(view.getParent(folder), group);
  assert.equal(view.getParent(group), prNode);
  // The folder has a dot while a file in it is not viewed (a collapsed folder says so too).
  const folderDeco = () => mock.decorationProviders.map((d) => d.provideFileDecoration(folder.getTreeItem().resourceUri)).find(Boolean);
  assert.ok(folderDeco(), 'folder dot');
  await run('commitCorner.markCommitFileViewed', folder, [folder]);
  assert.equal(group.getTreeItem().description, '2/3 viewed');
  assert.equal(folderDeco(), undefined, 'no folder dot once all in it are viewed');
  // With the dots off, a file still offers its Mark menus (by its state) and the list counts.
  mock.configValues.set('markUnviewedFiles', false);
  mock.events.onDidChangeConfiguration.fire({ affectsConfiguration: (k) => k === 'commitCorner.markUnviewedFiles' });
  try {
    assert.equal(deleted.getTreeItem().contextValue, 'file:pr:new');
    assert.match(deleted.getTreeItem().tooltip, /Not viewed yet/);
  } finally {
    mock.configValues.delete('markUnviewedFiles');
    mock.events.onDidChangeConfiguration.fire({ affectsConfiguration: (k) => k === 'commitCorner.markUnviewedFiles' });
  }
  // A file the pull request deleted (in its first commit): read from the merge base, not from
  // the parent of its last commit (where it is gone too).
  mock.executed.length = 0;
  await run('commitCorner.compareFileWithWorkingTree', deleted);
  const diff = mock.executed.find((e) => e.id === 'vscode.diff');
  assert.ok(diff && String(diff.args[0]).includes(head) && !String(diff.args[0]).includes(first), `left side from the merge base: ${diff && diff.args[0]}`);
  // Restore and Open File at Commit read it from there too.
  const repo = api.manager.getRepository(r.dir);
  const restored = [];
  const saved = { restoreFile: repo.restoreFile };
  repo.restoreFile = async (file, rev) => restored.push([file, rev]);
  try {
    mock.ui.answers.push('Restore');
    await run('commitCorner.restoreFileFromCommit', deleted);
  } finally {
    repo.restoreFile = saved.restoreFile;
  }
  assert.deepEqual(restored, [[gone, head]]);
  assert.ok(mock.ui.messages.some((m) => m.msg.includes(head.slice(0, 7)) && m.msg.includes('before it was deleted')), 'the dialog names that version');
  // The dots setting switched: the rows with marks are redrawn, the pull requests are not listed again.
  fired.length = 0;
  const listed = view.getRoots;
  let relisted = 0;
  view.getRoots = async () => {
    relisted++;
    return listed.call(view);
  };
  try {
    mock.events.onDidChangeConfiguration.fire({ affectsConfiguration: (k) => k === 'commitCorner.markUnviewedFiles' });
    await new Promise((res) => setTimeout(res, 400));
  } finally {
    view.getRoots = listed;
  }
  assert.ok(fired.some((e) => Array.isArray(e) && e.includes(group)), 'the Files changed row');
  assert.ok(!fired.includes(undefined) && relisted === 0, 'no full refresh');
  // The menus that work on any file still match (Open Working File and the others).
  const when = pkg.contributes.menus['view/item/context'].find((m) => m.command === 'commitCorner.openWorkingFile').when;
  const re = new RegExp(/viewItem =~ \/(.*?)\/ /.exec(when)[1]);
  assert.ok(re.test('file:pr:new') && re.test('file:pr:viewed'));
});

test('a row is redrawn after its own children have loaded and the view has been quiet; other rows wait 3 s at most', async () => {
  const { TreeProvider } = require('../src/vscode/views/nodes');
  const provider = new TreeProvider();
  const fired = [];
  provider.onDidChangeTreeData((e) => fired.push(e));
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const pending = () => {
    let finish;
    const node = { getChildren: () => new Promise((res) => (finish = res)), getTreeItem: () => ({}) };
    return { node, finish: (v) => finish(v) };
  };
  // A row redrawn while its own children load (a pull request just fetched): after them, then
  // once the rows below have loaded too.
  const pr = pending();
  const loading = provider.getChildren(pr.node);
  provider.redraw(pr.node);
  provider.redraw([pr.node]);
  await sleep(500);
  assert.deepEqual(fired, [], 'held while its children load');
  pr.finish([]);
  await loading;
  await sleep(50);
  assert.deepEqual(fired, [], 'and for a moment after (VS Code asks for the next level)');
  await sleep(450);
  assert.deepEqual(fired, [[pr.node]], 'then once');
  // Its own children loading for long (a slow fetch): it waits for them, beyond the 3 s that
  // other rows wait at most; then for the rows below.
  const slowPr = pending();
  const slowLoad = provider.getChildren(slowPr.node);
  provider.redraw(slowPr.node);
  await sleep(3500);
  assert.equal(fired.length, 1, 'still held after 3.5 s');
  slowPr.finish([]);
  await slowLoad;
  await sleep(50);
  assert.equal(fired.length, 1, 'and a moment after');
  await sleep(450);
  assert.deepEqual(fired[1], [slowPr.node]);
  fired.splice(1);
  // Idle: at once.
  provider.redraw(pr.node);
  assert.equal(fired.length, 2);
  // Another row, while something else in the view loads for long (another pull request being
  // fetched): 3 s at most.
  const slow = pending();
  const busy = provider.getChildren(slow.node);
  const other = { getTreeItem: () => ({}) };
  provider.redraw(other);
  await sleep(2500);
  assert.equal(fired.length, 2, 'held while the view loads');
  await sleep(1000);
  assert.deepEqual(fired[2], [other], 'not longer than 3 s');
  // A full refresh drops what was waiting.
  provider.redraw(other);
  provider.refresh();
  slow.finish([]);
  await busy;
  await sleep(500);
  assert.deepEqual(fired.slice(3), [undefined]);
  provider.dispose();
});

test('Compare with the working tree: a file has a dot until opened, and again when it changes', async (t) => {
  const { WORKTREE } = require('../src/git/repository');
  r.write('cmp-work.txt', 'one\n');
  t.after(() => fs.rmSync(path.join(r.dir, 'cmp-work.txt'), { force: true }));
  await api.manager.refresh(repo());
  const view = mock.treeViews.get('commitCorner.compare').provider;
  t.after(() => view.clear());
  await view.setComparison(repo(), 'HEAD', WORKTREE, 'twoDot');
  const row = async () => {
    const roots = await view.getChildren();
    const group = roots.find((n) => /Files changed/.test(n.label || ''));
    const flat = async (list) => (await Promise.all(list.map(async (n) => (n.path ? [n] : flat(await view.getChildren(n)))))).flat();
    return { group, file: (await flat(await view.getChildren(group))).find((n) => n.path === 'cmp-work.txt') };
  };
  let { group, file } = await row();
  assert.equal(file.getTreeItem().contextValue, 'file:compareWork:new');
  const { command, arguments: args } = file.getTreeItem().command;
  await run(command, ...args);
  assert.equal(file.getTreeItem().contextValue, 'file:compareWork:viewed');
  assert.match(group.getTreeItem().description, /viewed/);
  // Edited again: its dot is back.
  r.write('cmp-work.txt', 'two\n');
  ({ group, file } = await row());
  assert.equal(file.getTreeItem().contextValue, 'file:compareWork:new');
  assert.doesNotMatch(group.getTreeItem().description, /viewed/);
  // A folder's dot follows its files: gone once all are viewed, back when one changes again.
  fs.mkdirSync(path.join(r.dir, 'cmpdir'), { recursive: true });
  t.after(() => fs.rmSync(path.join(r.dir, 'cmpdir'), { recursive: true, force: true }));
  r.write('cmpdir/x.txt', 'x\n');
  await api.manager.refresh(repo());
  await view.setComparison(repo(), 'HEAD', WORKTREE, 'twoDot');
  const folderOf = async () => (await view.getChildren((await view.getChildren()).find((n) => /Files changed/.test(n.label || '')))).find((n) => n.name === 'cmpdir');
  const dot = (uri) => mock.decorationProviders.map((d) => d.provideFileDecoration(uri)).find(Boolean);
  let dir = await folderOf();
  assert.ok(dot(dir.getTreeItem().resourceUri), 'folder dot');
  const [x] = await view.getChildren(dir);
  await run('commitCorner.markCommitFileViewed', x);
  assert.equal(dot(dir.getTreeItem().resourceUri), undefined, 'all viewed: no folder dot');
  const before = String(dir.getTreeItem().resourceUri);
  r.write('cmpdir/x.txt', 'x changed\n');
  dir = await folderOf();
  assert.notEqual(String(dir.getTreeItem().resourceUri), before, 'a new key: VS Code asks for its dot again');
  assert.ok(dot(dir.getTreeItem().resourceUri), 'its dot is back');
  // The working tree changed but nothing shown did: no redraw; a file edited: Files changed alone.
  await new Promise((res) => setTimeout(res, 400)); // the mark's own redraw first
  const firedCmp = [];
  const subCmp = view.onDidChangeTreeData((e) => firedCmp.push(e));
  t.after(() => subCmp.dispose());
  await view.reloadFiles();
  await new Promise((res) => setTimeout(res, 400));
  assert.deepEqual(firedCmp, [], 'nothing changed: nothing redrawn');
  r.write('cmpdir/x.txt', 'x changed again\n');
  await view.reloadFiles();
  await new Promise((res) => setTimeout(res, 400));
  assert.deepEqual(firedCmp, [[view.filesGroup]], 'only Files changed');
  // Compare between two refs keeps the marks of an unchanged file.
  await view.setComparison(repo(), 'feature~1', 'feature');
  const roots = await view.getChildren();
  const refGroup = roots.find((n) => /Files changed/.test(n.label || ''));
  const [b] = await view.getChildren(refGroup);
  assert.equal(b.getTreeItem().contextValue, 'file:compare:new');
  await run('commitCorner.markCommitFileViewed', b);
  const [again] = await view.getChildren((await view.getChildren()).find((n) => /Files changed/.test(n.label || '')));
  assert.equal(again.getTreeItem().contextValue, 'file:compare:viewed', 'still viewed when drawn again');
  // Its sides are commit ids, whatever was compared by name (its menus read what the diff shows).
  assert.match(again.sha, /^[0-9a-f]{40}$/);
  assert.match(again.leftRef, /^[0-9a-f]{40}$/);
});

test('folder dots stay cheap on a very deep tree (none past the depth limit)', () => {
  const { fileNodes } = require('../src/vscode/views/nodes');
  const deep = Array.from({ length: 300 }, (_, k) => Array.from({ length: k + 1 }, (_, i) => `d${i}`).join('/') + '/f.txt');
  const files = deep.map((p) => ({ status: 'A', path: p, newBlob: 'a'.repeat(40) }));
  const ids = new Map(files.map((f) => [f.path, f.newBlob]));
  const t0 = Date.now();
  const tree = fileNodes(repo(), files, { leftRef: 'a'.repeat(40), rightRef: 'b'.repeat(40), contextValue: 'file:pr' }, { tree: true, viewed: { scope: 'deep', ids } });
  let folder = tree[0];
  let depth = 0;
  const walk = (n) => {
    n.getTreeItem();
    for (const c of n.children || []) walk(c);
  };
  walk(folder);
  while (folder && folder.children) {
    depth++;
    if (depth > 70) assert.equal(folder.marksId, undefined, `no dot at depth ${depth}`);
    folder = folder.children.find((c) => c.children);
  }
  assert.ok(Date.now() - t0 < 3000, `drawn in ${Date.now() - t0} ms`);
});

test('with several repositories a view starts with a row naming its own; folders are not kept for collapsing unless asked', async () => {
  const { TreeProvider, fileNodes } = require('../src/vscode/views/nodes');
  const repos = [{ name: 'app', root: '/w/app', absolute: (p) => `/w/app/${p}` }, { name: 'lib', root: '/w/lib' }];
  const events = { onDidOpen: () => ({ dispose() {} }), onDidClose: () => ({ dispose() {} }) };
  const manager = { repositories: repos, active: repos[0], ...events };
  const provider = new TreeProvider();
  provider.manager = manager;
  const subs = provider.watchRepositories(manager);
  const files = Array.from({ length: 20 }, (_, k) => ({ status: 'M', path: `src/d${k % 4}/f${k}.js` }));
  provider.getRoots = async () => fileNodes(repos[0], files, { leftRef: 'a'.repeat(40), rightRef: 'b'.repeat(40), parent: {} }, { tree: true });
  let roots = await provider.getChildren();
  assert.equal(roots[0].constructor.name, 'RepositoryRow');
  assert.equal(roots[0].getTreeItem().label, 'app');
  assert.equal(roots[0].getTreeItem().command.command, 'commitCorner.switchRepositoryFromRow');
  assert.equal(roots[0].getTreeItem().command.arguments[0], roots[0]);
  manager.repositories = [repos[0]];
  roots = await provider.getChildren();
  assert.notEqual(roots[0].constructor.name, 'RepositoryRow', 'one repository: no row');
  // Drawn again and again (a refresh of a commit's files): nothing kept per folder.
  for (let k = 0; k < 50; k++) {
    const list = await provider.getChildren();
    for (const f of list) if (f.children) await provider.getChildren(f);
  }
  assert.equal(provider.folderRows.size, 0);
  subs.forEach((d) => d.dispose());
  provider.dispose();
});

test('switching from a repository row: Compare and File History leave the old repository', () => {
  const { CompareView } = require('../src/vscode/views/compareView');
  const { FileHistoryView } = require('../src/vscode/views/fileHistoryView');
  const cmp = { state: { repo: 'A' }, manager: { active: 'B' }, clear() { this.cleared = true; }, refresh() { this.refreshed = true; } };
  CompareView.prototype.repositorySwitched.call(cmp);
  assert.ok(cmp.cleared, 'a comparison of the old repository is cleared');
  const same = { state: { repo: 'B' }, manager: { active: 'B' }, clear() { this.cleared = true; }, refresh() { this.refreshed = true; } };
  CompareView.prototype.repositorySwitched.call(same);
  assert.ok(!same.cleared && same.refreshed, 'the same repository picked: kept');
  const hist = { target: { repo: 'A' }, pinned: true, manager: { active: 'B' }, setPinnedContext() {}, setTarget(t) { this.target = t; } };
  FileHistoryView.prototype.repositorySwitched.call(hist);
  assert.equal(hist.target, undefined);
  assert.equal(hist.pinned, false);
});

/** Poll until `fn` returns something truthy (button handlers and refreshes run after the call). */
async function until(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Messages shown since `from` (an index into mock.ui.messages). */
const shownSince = (from) => mock.ui.messages.slice(from);

/** Undo what an agent-copies test left: open nested repositories, .local-work, the active one. */
async function cleanAgentCopies(main) {
  for (const x of api.manager.repositories) if (x !== main) api.manager.closeRepository(x);
  api.manager.setActive(main);
  fs.rmSync(path.join(r.dir, '.local-work'), { recursive: true, force: true });
  await api.manager.refresh(main);
}

test('a file git leaves out when staging (in a repository nested since it was listed) is a warning that opens that repository', async () => {
  const main = repo();
  const nestedRoot = path.join(r.dir, '.local-work', 'c1');
  try {
    r.write('.local-work/c1/new.txt', 'n\n');
    await api.manager.refresh(main);
    assert.ok(main.state.untracked.some((e) => e.path === '.local-work/c1/new.txt'), 'listed while it had no .git');
    r.git('init', '-q', nestedRoot);
    const from = mock.ui.messages.length;
    mock.ui.answers.push('Open Repository');
    await run('commitCorner.stage', { repoRoot: main.root, path: '.local-work/c1/new.txt', group: 'untracked' });
    const said = shownSince(from);
    assert.ok(said.some((m) => m.level === 'warning' && /^"\.local-work\/c1\/new\.txt" was not staged: it is in "\.local-work\/c1\/", a separate Git repository/.test(m.msg)), JSON.stringify(said));
    assert.ok(!said.some((m) => m.level === 'error'), 'a warning, not a failure');
    assert.equal(r.git('diff', '--cached', '--name-only'), '');
    const nested = await until(() => api.manager.repositories.find((x) => x.root === nestedRoot), 'the nested repository opened');
    assert.equal(api.manager.active, nested, 'and shown');
    await until(() => mock.executed.some((c) => c.id === 'workbench.view.scm'), 'Source Control shown');
  } finally {
    await cleanAgentCopies(main);
  }
});

test('with files in several nested repositories, Open Repository asks which', async () => {
  const main = repo();
  try {
    r.write('.local-work/c1/x.txt', 'x\n');
    r.write('.local-work/c2/y.txt', 'y\n');
    await api.manager.refresh(main);
    r.git('init', '-q', path.join(r.dir, '.local-work', 'c1'));
    r.git('init', '-q', path.join(r.dir, '.local-work', 'c2'));
    const from = mock.ui.messages.length;
    mock.ui.answers.push('Open Repository', '.local-work/c2/');
    await run('commitCorner.stage', [{ repoRoot: main.root, path: '.local-work/c1/x.txt' }, { repoRoot: main.root, path: '.local-work/c2/y.txt' }]);
    assert.ok(shownSince(from).some((m) => /^2 files were not staged: they are in "\.local-work\/c1\/" and "\.local-work\/c2\/", separate Git repositories/.test(m.msg)));
    await until(() => api.manager.active && api.manager.active.root === path.join(r.dir, '.local-work', 'c2'), 'the picked one opened');
  } finally {
    await cleanAgentCopies(main);
  }
});

test('Commit Selected with a file of a nested repository commits nothing and stages nothing', async () => {
  const main = repo();
  const head = r.git('rev-parse', 'HEAD');
  try {
    r.write('.local-work/c1/x.txt', 'x\n');
    r.write('mine-selected.txt', 'm\n');
    await api.manager.refresh(main);
    r.git('init', '-q', path.join(r.dir, '.local-work', 'c1'));
    mock.sourceControls[0].inputBox.value = 'both';
    const from = mock.ui.messages.length;
    await run('commitCorner.commitSelected', { repoRoot: main.root, path: '.local-work/c1/x.txt', group: 'untracked' }, { repoRoot: main.root, path: 'mine-selected.txt', group: 'untracked' });
    const said = shownSince(from);
    assert.ok(said.some((m) => m.level === 'warning' && /^Nothing committed: "\.local-work\/c1\/x\.txt" is in "\.local-work\/c1\/", a separate Git repository inside this one, and git skips its files without a word\. Commit it there, or leave it out of the selection\.$/.test(m.msg)), JSON.stringify(said));
    assert.equal(r.git('rev-parse', 'HEAD'), head, 'no commit');
    assert.equal(r.git('diff', '--cached', '--name-only'), '', 'and nothing staged on the way');
  } finally {
    mock.sourceControls[0].inputBox.value = '';
    fs.rmSync(path.join(r.dir, 'mine-selected.txt'), { force: true });
    await cleanAgentCopies(main);
  }
});

test('Commit Selected that stages nothing keeps a deletion you had staged for a picked path', async () => {
  const main = repo();
  const head = r.git('rev-parse', 'HEAD');
  try {
    r.commit('secret', { 'secret.env': 's\n' });
    r.git('rm', '-q', '--cached', 'secret.env');
    r.write('.local-work/c1/x.txt', 'x\n');
    await api.manager.refresh(main);
    r.git('init', '-q', path.join(r.dir, '.local-work', 'c1'));
    mock.sourceControls[0].inputBox.value = 'both';
    await run('commitCorner.commitSelected', { repoRoot: main.root, path: 'secret.env', group: 'untracked' }, { repoRoot: main.root, path: '.local-work/c1/x.txt', group: 'untracked' });
    assert.match(r.git('status', '--porcelain', '--', 'secret.env'), /^D {2}secret\.env$/m, 'still a staged deletion');
  } finally {
    mock.sourceControls[0].inputBox.value = '';
    r.git('reset', '-q', head);
    fs.rmSync(path.join(r.dir, 'secret.env'), { force: true });
    await cleanAgentCopies(main);
  }
});

test('over the status limit, the folder that floods the list is named and can be excluded in this clone only', async () => {
  const main = repo();
  const exclude = path.join(r.dir, '.git', 'info', 'exclude');
  const before = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : undefined;
  mock.configValues.set('statusLimit', 5);
  for (let i = 0; i < 8; i++) r.write(`.local-work/copy/f${i}.txt`, `${i}\n`);
  r.write('lone-new.txt', 'x\n');
  const from = mock.ui.messages.length;
  mock.ui.answers.push('Exclude ".local-work/copy/" Locally');
  try {
    await api.manager.refresh(main);
    const warning = await until(() => shownSince(from).find((m) => m.level === 'warning'), 'the warning');
    assert.equal(warning.msg, `${main.name} has 9 changed files, 8 of them new files in ".local-work/copy/"; Source Control shows the first 5. Exclude that folder (in this clone only), add it to .gitignore, or raise "commitCorner.statusLimit".`);
    await until(() => fs.existsSync(exclude) && fs.readFileSync(exclude, 'utf8').split('\n').includes('/.local-work/copy/'), 'the folder excluded');
    await until(() => main.state.untracked.length === 1, 'the refresh after excluding');
    assert.deepEqual(main.state.untracked.map((e) => e.path), ['lone-new.txt']);
    assert.ok(shownSince(from).some((m) => m.level === 'info' && /"\.local-work\/copy\/" is now ignored in this clone/.test(m.msg)));
    assert.equal(fs.existsSync(path.join(r.dir, '.gitignore')) && /local-work/.test(fs.readFileSync(path.join(r.dir, '.gitignore'), 'utf8')), false, '.gitignore untouched');
  } finally {
    mock.configValues.delete('statusLimit');
    if (before === undefined) fs.rmSync(exclude, { force: true });
    else fs.writeFileSync(exclude, before);
    fs.rmSync(path.join(r.dir, 'lone-new.txt'), { force: true });
    await cleanAgentCopies(main);
  }
});

test('over the status limit, a flooding folder that also holds tracked files is named but not offered for excluding', async () => {
  const main = repo();
  mock.configValues.set('statusLimit', 5);
  r.commit('tracked in gen', { 'gen/kept.txt': 'k\n' });
  for (let i = 0; i < 8; i++) r.write(`gen/out/f${i}.txt`, `${i}\n`);
  const from = mock.ui.messages.length;
  try {
    await api.manager.refresh(main);
    const warning = await until(() => shownSince(from).find((m) => m.level === 'warning'), 'the warning');
    assert.match(warning.msg, /8 of them new files in "gen\/out\/"/);
    // gen/out/ holds no tracked file: it may be excluded. Its parent with kept.txt is never offered.
    assert.match(warning.msg, /Exclude that folder/);
  } finally {
    mock.configValues.delete('statusLimit');
    fs.rmSync(path.join(r.dir, 'gen', 'out'), { recursive: true, force: true });
    await api.manager.refresh(main);
  }
  mock.configValues.set('statusLimit', 5);
  for (let i = 0; i < 8; i++) r.write(`gen/f${i}.txt`, `${i}\n`);
  const from2 = mock.ui.messages.length;
  try {
    await api.manager.refresh(main);
    const warning = await until(() => shownSince(from2).find((m) => m.level === 'warning'), 'the warning');
    assert.match(warning.msg, /8 of them new files in "gen\/", where git also tracks files; Source Control shows the first 5\. Ignore the generated ones in \.gitignore, or raise/);
  } finally {
    mock.configValues.delete('statusLimit');
    for (let i = 0; i < 8; i++) fs.rmSync(path.join(r.dir, 'gen', `f${i}.txt`), { force: true });
    await api.manager.refresh(main);
  }
});

test('floodingFolder() names the deepest folder holding nearly all new files, when they are at least half of all changes', () => {
  const { floodingFolder } = require('../src/vscode/scm');
  const u = (list) => list.map((p) => ({ path: p }));
  const gen = Array.from({ length: 95 }, (_, k) => `src/gen/f${k}`);
  assert.deepEqual(floodingFolder(u([...gen, 'src/a', 'src/b', 'x/y', 'top']), 99), { dir: 'src/gen/', count: 95 });
  assert.deepEqual(floodingFolder(u(['.local-work/c0/a', '.local-work/c1/a', '.local-work/c2/a']), 3), { dir: '.local-work/', count: 3 }, 'spread over copies: their common folder');
  assert.equal(floodingFolder(u(['a/1', 'b/1', 'c/1']), 3), undefined, 'spread over several folders');
  assert.deepEqual(floodingFolder(u(['a/1', 'b/2']), 2), { dir: 'a/', count: 1 }, 'exactly half is enough');
  assert.equal(floodingFolder(u(['t1', 't2', 't3']), 3), undefined, 'top-level files only');
  assert.equal(floodingFolder(u(['a/1', 'a/2']), 5), undefined, 'most changes are to tracked files');
});

test('a .git appearing or going below the root refreshes the repository; the root\'s own, or one that only changes, does not', async () => {
  const main = repo();
  const nestedRoot = path.join(r.dir, '.local-work', 'c3');
  const watcher = mock.fileWatchers.find((w) => w.pattern && w.pattern.base && w.pattern.base.fsPath === main.root);
  assert.ok(watcher, 'the repository\'s working tree watcher');
  r.write('.local-work/c3/a.txt', 'a\n');
  await api.manager.refresh(main);
  assert.ok(main.state.untracked.some((e) => e.path === '.local-work/c3/a.txt'));
  // Nothing pending from earlier tests: only refreshes these events cause are counted.
  api.manager.refreshers.get(main.root).cancel();
  await api.manager.refresh(main);
  let refreshes = 0;
  const original = main.refreshState;
  main.refreshState = (...a) => {
    refreshes++;
    return original.apply(main, a);
  };
  try {
    r.git('init', '-q', nestedRoot);
    const dotGit = mock.vscode.Uri.file(path.join(nestedRoot, '.git'));
    // Its repository at work: the folder changes, files inside it come and go; the root's own .git.
    watcher.change.fire(dotGit);
    watcher.create.fire(mock.vscode.Uri.file(path.join(nestedRoot, '.git', 'index.lock')));
    watcher.create.fire(mock.vscode.Uri.file(path.join(main.root, '.git')));
    // Longer than any debounce a refresh would wait for (it follows the last status's cost).
    await new Promise((resolve) => setTimeout(resolve, Math.max(250, 3 * (api.manager.lastRefreshMs.get(main.root) || 0)) + 300));
    assert.equal(refreshes, 0, 'nothing in this repository changed');
    // Created: an agent's copy got its .git after its files.
    watcher.create.fire(dotGit);
    await until(() => main.state.nested.includes('.local-work/c3/'), 'the copy seen as a repository');
    assert.ok(!main.state.untracked.some((e) => e.path.startsWith('.local-work/c3/')), 'its files are no longer this repository\'s');
    // Gone again: its files are this repository's untracked files once more.
    fs.rmSync(path.join(nestedRoot, '.git'), { recursive: true, force: true });
    watcher.delete.fire(dotGit);
    await until(() => main.state.untracked.some((e) => e.path === '.local-work/c3/a.txt'), 'the copy\'s files listed again');
  } finally {
    main.refreshState = original;
    await cleanAgentCopies(main);
  }
});

test('staging an Untracked group of thousands of files goes folder by folder, nested repositories left out', async () => {
  const main = repo();
  try {
    for (let i = 0; i < 1100; i++) r.write(`.local-work/copy/f${i}.txt`, `${i}\n`);
    r.write('.local-work/c1/x.txt', 'x\n');
    r.git('init', '-q', path.join(r.dir, '.local-work', 'c1'));
    await api.manager.refresh(main);
    assert.equal(main.state.untracked.length, 1100);
    const group = mock.sourceControls[0].groups.find((g) => g.id === 'untracked');
    const from = mock.ui.messages.length;
    const ran = [];
    const run0 = main.run.bind(main);
    main.run = (a, o) => {
      ran.push(a);
      return run0(a, o);
    };
    try {
      await run('commitCorner.stageAll', group);
    } finally {
      main.run = run0;
    }
    const add = ran.find((a) => a[0] === 'add');
    assert.ok(add && add.length < 20, `one pathspec for the folder (${add && add.length} arguments)`);
    assert.equal(r.git('diff', '--cached', '--name-only').split('\n').length, 1100);
    assert.ok(!shownSince(from).some((m) => m.level !== 'info'), JSON.stringify(shownSince(from)));
  } finally {
    r.git('reset', '-q');
    await cleanAgentCopies(main);
  }
});

test('no command reported an unexpected error', () => {
  const errors = mock.ui.messages.filter((m) => m.level === 'error');
  assert.deepEqual(errors, []);
});
