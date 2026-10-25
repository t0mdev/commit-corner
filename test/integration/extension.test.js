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
});
