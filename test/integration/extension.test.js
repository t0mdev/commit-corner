'use strict';

/**
 * Integration tests in a real VS Code: activation, contributions and the
 * VS Code API shapes the extension depends on. The workspace is a throwaway
 * repository created by .vscode-test.mjs (branches main and feature).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const vscode = require('vscode');

const pkg = require('../../package.json');
const EXTENSION_ID = `${pkg.publisher}.${pkg.name}`;

const root = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
const git = (...args) => execFileSync('git', args, { cwd: root(), encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn` returns something truthy (VS Code updates arrive asynchronously). */
async function until(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

let api;

suite('Commit Corner in VS Code', () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} is installed`);
    api = await ext.activate();
    await until(() => api.manager.repositories.length === 1, 'the workspace repository');
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('every contributed command is registered', async () => {
    const all = new Set(await vscode.commands.getCommands(true));
    const missing = pkg.contributes.commands.map((c) => c.command).filter((c) => !all.has(c));
    assert.deepStrictEqual(missing, []);
  });

  test('internal VS Code commands the extension relies on still exist', async () => {
    const all = new Set(await vscode.commands.getCommands(false)); // with the "_" ones
    // (Space in Viewed lists runs list.select / list.toggleExpand; conflicts open _open.mergeEditor.)
    for (const id of ['vscode.changes', 'vscode.diff', 'list.select', 'list.toggleExpand', '_open.mergeEditor', 'workbench.view.scm']) assert.ok(all.has(id), id);
  });

  test('the repository is found and has a Source Control provider', async () => {
    const repo = api.manager.repositories[0];
    assert.strictEqual(fs.realpathSync(repo.root), fs.realpathSync(root()));
    assert.ok(api.scm.get(repo), 'SCM provider');
  });

  test('a working-tree change opens as a native diff against the index', async () => {
    const file = path.join(root(), 'a.txt');
    fs.writeFileSync(file, 'one\nTWO\nthree\nfour\n');
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
    await vscode.commands.executeCommand('commitCorner.openChanges');
    const tab = await until(() => {
      const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      return t && t.input instanceof vscode.TabInputTextDiff ? t : undefined;
    }, 'a diff editor');
    assert.strictEqual(tab.input.original.scheme, 'commitcorner');
    const left = await vscode.workspace.openTextDocument(tab.input.original);
    assert.strictEqual(left.getText(), 'one\nTWO\nthree\n', 'the left side is the index version');
  });

  test('staging the active file and committing through the Source Control input', async () => {
    const repo = api.manager.repositories[0];
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(root(), 'a.txt')));
    await vscode.commands.executeCommand('commitCorner.stage');
    await until(() => git('diff', '--cached', '--name-only') === 'a.txt', 'a.txt to be staged');
    await api.manager.refresh(repo);
    api.scm.get(repo).sc.inputBox.value = 'Add four';
    await vscode.commands.executeCommand('commitCorner.commit', repo);
    await until(() => git('log', '-1', '--format=%s') === 'Add four', 'the commit');
  });

  test('a commit opens in the multi-diff editor', async () => {
    const sha = git('rev-parse', 'HEAD');
    await vscode.commands.executeCommand('commitCorner.showCommit', { repoRoot: api.manager.repositories[0].root, sha });
    await until(() => {
      const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      return t && t.input instanceof vscode.TabInputTextMultiDiff;
    }, 'a multi-diff editor');
  });

  /** A merge with one resolved conflict, made without touching the working tree (helpers/merge.js). */
  const makeMerge = () => require('../helpers/merge').makeMerge(root());

  const activeMultiDiff = () => {
    const t = vscode.window.tabGroups.activeTabGroup.activeTab;
    return t && t.input instanceof vscode.TabInputTextMultiDiff ? t.input : undefined;
  };

  test('Show Merge Resolution: only the resolved file, against git\'s automatic merge', async () => {
    const repo = api.manager.repositories[0];
    const merge = makeMerge();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('commitCorner.showMergeResolution', { repoRoot: repo.root, sha: merge });
    const input = await until(activeMultiDiff, 'a multi-diff editor');
    assert.deepStrictEqual(input.textDiffs.map((d) => path.basename(d.modified.fsPath)), ['mr.txt']);
    const left = JSON.parse(input.textDiffs[0].original.query);
    assert.strictEqual(left.rev, 'automatic merge');
    assert.match((await vscode.workspace.openTextDocument(input.textDiffs[0].original)).getText(), /^a\n<<<<<<< [0-9a-f]{40}\nB1\n=======\nB2\n>>>>>>> [0-9a-f]{40}\nc\n$/);
    assert.strictEqual(JSON.parse(input.textDiffs[0].modified.query).ref, merge);
  });

  test('Show Changes on a merge asks which view; Enter opens the resolution', async () => {
    const repo = api.manager.repositories[0];
    const merge = makeMerge();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const input = await pickAndAccept({ repoRoot: repo.root, sha: merge });
    assert.strictEqual(JSON.parse(input.textDiffs[0].original.query).rev, 'automatic merge');
  });

  /** Show Changes on a commit, Enter in the picker once it is up: the multi-diff it opens. */
  async function pickAndAccept(node) {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const shown = vscode.commands.executeCommand('commitCorner.showCommit', node);
    await sleep(300); // (the counts, known already, are in)
    // Enter until the picker took it (before it is up, Enter does nothing).
    const input = await until(async () => {
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      const d = activeMultiDiff();
      return d && d.textDiffs.length ? d : undefined;
    }, 'a multi-diff editor from the picker');
    await shown;
    return input;
  }

  test('a clean merge: Enter in the picker opens what it brought in (Changes vs Parent 1)', async () => {
    const repo = api.manager.repositories[0];
    const base = git('rev-parse', 'HEAD');
    const index = path.join(require('os').tmpdir(), `cc-clean-${process.pid}`);
    const env = { ...process.env, GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };
    const run = (args, input) => execFileSync('git', args, { cwd: root(), env, input, encoding: 'utf8' }).trim();
    const commit = (parent, file, text, msg) => {
      run(['read-tree', parent]);
      run(['update-index', '--add', '--cacheinfo', `100644,${run(['hash-object', '-w', '--stdin'], text)},${file}`]);
      return run(['commit-tree', run(['write-tree']), '-p', parent, '-m', msg]);
    };
    const one = commit(base, 'clean-one.txt', '1\n', 'one');
    // (A changed file, not an added one: the tab lists only diffs with two sides.)
    const two = commit(base, 'b.txt', 'b\nclean two\n', 'two');
    run(['read-tree', one]);
    run(['update-index', '--add', '--cacheinfo', `100644,${run(['hash-object', '-w', '--stdin'], 'b\nclean two\n')},b.txt`]);
    const merge = run(['commit-tree', run(['write-tree']), '-p', one, '-p', two, '-m', 'Clean merge']);
    fs.rmSync(index, { force: true });
    assert.deepStrictEqual((await repo.getMergeResolution(merge)).files, [], 'a clean merge');
    const input = await pickAndAccept({ repoRoot: repo.root, sha: merge });
    assert.deepStrictEqual(input.textDiffs.map((d) => path.basename(d.modified.fsPath)), ['b.txt']);
    assert.strictEqual(JSON.parse(input.textDiffs[0].original.query).ref, one, 'against parent 1');
    assert.strictEqual(JSON.parse(input.textDiffs[0].modified.query).ref, merge);
  });

  test('N in a merge resolution\'s diff stays in the resolution', async () => {
    const repo = api.manager.repositories[0];
    const merge = makeMerge();
    const r = await repo.getMergeResolution(merge);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('commitCorner.openCommitFile', { repoRoot: repo.root, sha: merge, path: 'mr.txt', status: 'M', leftRef: r.tree, viewedSha: merge, base: r.tree, leftLabel: 'automatic merge' });
    const tab = await until(() => {
      const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      return t && t.input instanceof vscode.TabInputTextDiff ? t : undefined;
    }, 'the resolution diff');
    assert.strictEqual(JSON.parse(tab.input.modified.query).base, r.tree);
    assert.match(tab.label, /automatic merge ↔/);
    // Its only file is viewed now: N says so for the resolution (and opens nothing of parent 1's).
    await vscode.commands.executeCommand('commitCorner.nextUnviewedFile');
    await sleep(300);
    assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab, tab, 'still the same diff');
  });

  test('a merge in a tree: Merge Resolution open, the parents\' changes closed with their counts', async () => {
    const { CommitNode } = require('../../src/vscode/views/nodes');
    const repo = api.manager.repositories[0];
    const merge = makeMerge();
    const sections = await new CommitNode(repo, await repo.getCommit(merge)).getChildren();
    // Each drawn once, in its state (git's answers are in by the time the rows are listed).
    const items = sections.map((s) => s.getTreeItem());
    assert.ok(items.every((i) => i.id === undefined), 'no ids: VS Code keeps what you opened across refreshes');
    assert.deepStrictEqual(items.map((i) => i.label), ['Merge Resolution', 'Changes vs Parent 1', 'Changes vs Parent 2']);
    assert.deepStrictEqual(items.map((i) => i.collapsibleState), [vscode.TreeItemCollapsibleState.Expanded, vscode.TreeItemCollapsibleState.Collapsed, vscode.TreeItemCollapsibleState.Collapsed]);
    assert.match(items[0].description, /^1 file/);
    assert.match(items[2].description, /^[0-9a-f]{7} · 2 files$/);
    const [file] = await sections[0].getChildren();
    const fileItem = file.getTreeItem();
    assert.match(fileItem.description, /conflict/);
    const [arg] = fileItem.command.arguments;
    assert.strictEqual(arg.leftLabel, 'automatic merge');
    assert.match(arg.base, /^[0-9a-f]{40}$/);
    // Its diff says which list it is from: Next Unviewed File stays in the resolution.
    const [leftUri, rightUri] = file.openUris().map((u) => vscode.Uri.parse(u));
    assert.strictEqual(JSON.parse(leftUri.query).rev, 'automatic merge');
    assert.strictEqual(JSON.parse(rightUri.query).base, arg.base);
  });

  test('a file at a revision is labelled with its short SHA (resourceLabelFormatters)', async () => {
    const { toGitUri } = require('../../src/vscode/uri');
    const repo = api.manager.repositories[0];
    const sha = git('rev-parse', 'HEAD');
    const file = git('ls-files').split('\n')[0];
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(toGitUri(repo.root, file, sha)));
    await until(() => {
      const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      return t && t.label === `${path.basename(file)} (${sha.slice(0, 7)})`;
    }, `a tab labelled "${path.basename(file)} (${sha.slice(0, 7)})"`);
  });

  test('the graph opens as a webview panel', async () => {
    await vscode.commands.executeCommand('commitCorner.showGraph');
    await until(() => vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.input instanceof vscode.TabInputWebview && /commitCorner\.graph/.test(t.input.viewType)), 'the graph tab');
  });

  test('the sidebar Graph view resolves and its title actions run', async () => {
    await vscode.commands.executeCommand('commitCorner.graphView.focus');
    await vscode.commands.executeCommand('commitCorner.graphView.refresh');
  });

  test('Repository Activity opens as a webview panel', async () => {
    await vscode.commands.executeCommand('commitCorner.showActivity');
    await until(() => vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.input instanceof vscode.TabInputWebview && /commitCorner\.activity/.test(t.input.viewType)), 'the activity tab');
  });

  test('the views can be focused', async () => {
    for (const v of pkg.contributes.views.commitCorner) await vscode.commands.executeCommand(`${v.id}.focus`);
  });

  test('a conflicted file opens in the 3-way merge editor (internal _open.mergeEditor)', async () => {
    const repo = api.manager.repositories[0];
    git('checkout', '-q', '-b', 'conflict-side');
    fs.writeFileSync(path.join(root(), 'm.txt'), 'theirs\n');
    git('add', 'm.txt');
    git('commit', '-q', '-m', 'side');
    git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(root(), 'm.txt'), 'ours\n');
    git('add', 'm.txt');
    git('commit', '-q', '-m', 'main side');
    try {
      git('merge', 'conflict-side');
    } catch { /* conflict expected */ }
    await api.manager.refresh(repo);
    await vscode.commands.executeCommand('commitCorner.openMergeEditor', vscode.Uri.file(path.join(root(), 'm.txt')));
    await until(() => vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.input instanceof vscode.TabInputTextMerge), 'the merge editor');
    git('merge', '--abort');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await api.manager.refresh(repo);
  });

  test('a review comment on a line: the gutter offers it, the thread follows its line, the review is copied', async () => {
    const file = path.join(root(), 'review-me.txt');
    fs.writeFileSync(file, 'one\ntwo\nthree\n');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc);
    const { store, controller } = api.review;
    const ranges = await controller.commentingRangeProvider.provideCommentingRanges(doc, new vscode.CancellationTokenSource().token);
    assert.strictEqual(ranges.length, 1, 'the + is offered in the gutter');
    // What VS Code does for the +: a thread on the line, then Add Comment with the text.
    const thread = controller.createCommentThread(doc.uri, new vscode.Range(1, 0, 1, 0), []);
    await vscode.commands.executeCommand('commitCorner.review.add', { thread, text: 'Say "2" here.' });
    const saved = store.forRoot(root());
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(thread.comments[0].body.value, 'Say "2" here.');
    // Two lines typed above it: the thread moves with "two".
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(0, 0), 'a\nb\n');
    await vscode.workspace.applyEdit(edit);
    await until(() => thread.range.start.line === 3, 'the thread to follow its line');
    await vscode.commands.executeCommand('commitCorner.review.copy', { reviewRoot: root() });
    assert.match(await vscode.env.clipboard.readText(), /`review-me\.txt`, line 4\n\n```txt\n4  two\n```\n\n> Say "2" here\./);
    await vscode.commands.executeCommand('commitCorner.review.deleteThread', thread);
    assert.strictEqual(store.forRoot(root()).length, 0);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    fs.rmSync(file);
  });

  test('editing the staged (index) side of a diff changes only the index', async () => {
    const repo = api.manager.repositories[0];
    fs.writeFileSync(path.join(root(), 'b.txt'), 'b\nworking tree\n');
    git('add', 'b.txt');
    const uri = vscode.Uri.from({ scheme: 'commitcorner', path: path.join(root(), 'b.txt'), query: JSON.stringify({ repo: repo.root, path: 'b.txt', ref: ':' }) });
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), 'b\nedited in the index\n');
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    assert.strictEqual(git('show', ':b.txt'), 'b\nedited in the index');
    assert.strictEqual(fs.readFileSync(path.join(root(), 'b.txt'), 'utf8'), 'b\nworking tree\n');
  });
  test('agents\' copies inside the repository: a copy that gets its .git is seen without a refresh; staging keeps up under 12,000 new files that keep changing', async function () {
    this.timeout(120000);
    const repo = api.manager.repositories[0];
    const work = path.join(root(), '.local-work');
    const copy = path.join(work, 'c1');
    let writer;
    try {
      // A copy whose files arrive before its .git (cp -r in directory order).
      fs.mkdirSync(path.join(copy, 'src'), { recursive: true });
      fs.writeFileSync(path.join(copy, 'src', 'a.txt'), 'a\n');
      await until(() => repo.state.untracked.some((e) => e.path === '.local-work/c1/src/a.txt'), 'the copy\'s file listed');
      execFileSync('git', ['init', '-q', copy]);
      await until(() => repo.state.nested.includes('.local-work/c1/'), 'the copy seen as a repository of its own (file watcher only)');
      assert.ok(!repo.state.untracked.some((e) => e.path.startsWith('.local-work/c1/')));
      // Staging one of its files anyway (a view that had not caught up): a warning, nothing staged.
      await vscode.commands.executeCommand('commitCorner.stage', { repoRoot: repo.root, path: '.local-work/c1/src/a.txt', group: 'untracked' });
      assert.strictEqual(git('ls-files', '--', '.local-work'), '');

      // Copies without a .git: thousands of new files, still being written while you stage.
      for (let d = 0; d < 12; d++) {
        const dir = path.join(work, `copy${d}`);
        fs.mkdirSync(dir, { recursive: true });
        for (let i = 0; i < 1000; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), `${i}\n`);
      }
      let started = Date.now();
      await until(() => repo.state.untracked.length >= 12000, 'the 12,000 new files listed', 60000);
      const listed = Date.now() - started;
      let tick = 0;
      writer = setInterval(() => {
        tick++;
        fs.writeFileSync(path.join(work, 'copy0', `f${tick % 1000}.txt`), `changed ${tick}\n`);
      }, 25);
      fs.writeFileSync(path.join(root(), 'mine-to-stage.txt'), 'mine\n');
      await until(() => repo.state.untracked.some((e) => e.path === 'mine-to-stage.txt'), 'my new file listed', 30000);
      started = Date.now();
      await vscode.commands.executeCommand('commitCorner.stage', { repoRoot: repo.root, path: 'mine-to-stage.txt', group: 'untracked' });
      await until(() => repo.state.staged.some((e) => e.path === 'mine-to-stage.txt'), 'my file shown as staged while files keep changing', 30000);
      const staged = Date.now() - started;
      const provider = api.scm.get(repo);
      const shown = provider.untracked.resourceStates.length;
      assert.ok(shown <= 10000, `Source Control lists at most the status limit (${shown})`);
      console.log(`      12,000 new files: listed in ${listed} ms; a stage shown in ${staged} ms while files kept changing`);
    } finally {
      clearInterval(writer);
      git('reset', '-q', '--', 'mine-to-stage.txt');
      fs.rmSync(path.join(root(), 'mine-to-stage.txt'), { force: true });
      fs.rmSync(work, { recursive: true, force: true });
      await api.manager.refresh(repo);
    }
  });
});
