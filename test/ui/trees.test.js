'use strict';

/**
 * The tree views in a real VS Code, read through the workbench's DOM (test/ui/cdp.js): what VS
 * Code shows, not only what the extension hands it.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const vscode = require('vscode');
const { targets, evaluate, press } = require('./cdp');

const pkg = require('../../package.json');

const root = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
const git = (cwd, args, input, extra = {}) => execFileSync('git', args, { cwd, env: { ...env, ...extra }, input, encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const workbench = async () => (await targets()).find((t) => t.type === 'page' && /workbench/.test(t.url));
const inWorkbench = async (expr) => evaluate(await workbench(), expr, { frame: false });

/** The context menus open now: each one's items as "label [keybinding]" (VS Code may draw them in a shadow root). */
const openMenus = () => inWorkbench(`(() => {
  const roots = [document, ...[...document.querySelectorAll('*')].filter((h) => h.shadowRoot).map((h) => h.shadowRoot)];
  return roots.flatMap((r) => [...r.querySelectorAll('.monaco-menu')]).map((m) => [...m.querySelectorAll('.action-menu-item')].map((i) => (i.querySelector('.action-label') || {}).textContent + ' [' + ((i.querySelector('.keybinding') || {}).textContent || '') + ']'));
})()`);

/** The sidebar's ··· menu (the shown Commit Corner view's), opened as a click does. */
async function openViewMenu() {
  await inWorkbench(`[...document.querySelectorAll('.part.sidebar .action-label')].find((a) => /^(Views and )?More Actions/.test(a.getAttribute('aria-label') || '')).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`);
  for (let i = 0; i < 20; i++) {
    const menus = await openMenus();
    if (menus.length) return menus[0];
    await sleep(100);
  }
  throw new Error('the ··· menu did not open');
}

/** How many rows the Pull Requests tree has (it draws only those on screen; its height counts all). */
async function pullRequestRows() {
  return inWorkbench(`(() => {
    const list = [...document.querySelectorAll('.monaco-list')].find((l) => l.getAttribute('aria-label') === 'Pull Requests');
    const rows = list && list.querySelector('.monaco-list-rows');
    const row = list && list.querySelector('.monaco-list-row');
    return rows && row ? Math.round(parseFloat(rows.style.height) / parseFloat(row.style.height)) : 0;
  })()`);
}

suite('Tree views', () => {
  test('a large pull request shows all its files the first time it is opened, even when fetching it takes a while', async function () {
    this.timeout(120000);
    const dir = root();
    // A remote publishing pull request #1 as GitHub does: 600 files in 20 × 6 folders.
    const remote = `${dir}-prs.git`;
    git(dir, ['init', '-q', '--bare', remote]);
    const main = git(dir, ['rev-parse', 'main']);
    const index = `${remote}-index`;
    git(dir, ['read-tree', main], undefined, { GIT_INDEX_FILE: index });
    const blob = git(dir, ['hash-object', '-w', '--stdin'], 'x\n');
    let info = '';
    for (let p = 0; p < 20; p++) for (let m = 0; m < 6; m++) for (let f = 0; f < 5; f++) info += `100644 ${blob}\tpkg${p}/mod${m}/file${f}.txt\n`;
    git(dir, ['update-index', '--index-info'], info, { GIT_INDEX_FILE: index });
    const tree = git(dir, ['write-tree'], undefined, { GIT_INDEX_FILE: index });
    fs.rmSync(index, { force: true });
    const head = git(dir, ['commit-tree', tree, '-p', main, '-m', 'Large pull request']);
    const merge = git(dir, ['commit-tree', tree, '-p', main, '-p', head, '-m', 'Test merge']);
    git(dir, ['push', '-q', remote, `${main}:refs/heads/main`, `${head}:refs/pull/1/head`, `${merge}:refs/pull/1/merge`]);
    git(dir, ['remote', 'add', 'prs', remote]);
    // The network and a large diff, slowed down: the row is redrawn (fetched) while its files load.
    const { Repository } = require('../../src/git/repository');
    const saved = { fetchPullRequest: Repository.prototype.fetchPullRequest, diffFiles: Repository.prototype.diffFiles };
    Repository.prototype.fetchPullRequest = async function (...a) {
      await sleep(1500);
      return saved.fetchPullRequest.apply(this, a);
    };
    Repository.prototype.diffFiles = async function (...a) {
      const out = await saved.diffFiles.apply(this, a);
      await sleep(3000);
      return out;
    };
    const { PullRequestsView } = require('../../src/vscode/views/pullRequestsView');
    const getChildren = PullRequestsView.prototype.getChildren;
    let roots = [];
    const loaded = [];
    PullRequestsView.prototype.getChildren = async function (node) {
      const children = await getChildren.call(this, node);
      if (!node) roots = children;
      loaded.push(...children);
      return children;
    };
    try {
      await vscode.commands.executeCommand('commitCorner.sidebar.pullRequests');
      await vscode.commands.executeCommand('commitCorner.prRefresh');
      for (let i = 0; i < 100 && !roots.some((n) => n.number === 1); i++) await sleep(100);
      const pr = roots.find((n) => n.number === 1);
      assert.ok(pr, 'pull request #1 is listed');
      const view = require('../../src/vscode/util').treeViews.get('commitCorner.pullRequests');
      await view.reveal(pr, { expand: true, select: true });
      // The pull request, its three rows (base, commits, files), 20 + 120 folders and 600 files.
      const all = 1 + 3 + 20 + 120 + 600;
      let rows = 0;
      for (let i = 0; i < 60 && rows !== all; i++) {
        await sleep(250);
        rows = await pullRequestRows();
      }
      // And it stays so once the row has been redrawn.
      await sleep(1500);
      assert.strictEqual(await pullRequestRows(), all);
      // One of its files opened: its diff's title bar has Next Unviewed File, which opens the
      // next file of this pull request.
      const file = loaded.find((n) => n.path === 'pkg0/mod0/file0.txt');
      await file.open({ preserveFocus: false });
      const nextButton = () => inWorkbench(`!!document.querySelector('.editor-actions .action-label[aria-label^="Next Unviewed File"]')`);
      for (let i = 0; i < 20 && !(await nextButton()); i++) await sleep(100);
      assert.ok(await nextButton(), 'Next Unviewed File in the title bar');
      await vscode.commands.executeCommand('commitCorner.nextUnviewedFile');
      const tab = () => vscode.window.tabGroups.activeTabGroup.activeTab;
      for (let i = 0; i < 20 && !/file1\.txt/.test(tab() && tab().label); i++) await sleep(100);
      assert.match(tab().label, /file1\.txt/);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    } finally {
      Object.assign(Repository.prototype, saved);
      PullRequestsView.prototype.getChildren = getChildren;
      git(dir, ['remote', 'remove', 'prs']);
      fs.rmSync(remote, { recursive: true, force: true });
      await vscode.commands.executeCommand('commitCorner.sidebar.graphView');
    }
  });

  test('each view\'s ··· menu has Review (Copy with its shortcut, Save, Delete All) while there are review comments', async function () {
    this.timeout(60000);
    const api = await vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`).activate();
    for (const id of ['graphView', 'worktrees']) {
      await vscode.commands.executeCommand(`commitCorner.sidebar.${id}`);
      await sleep(500);
      assert.ok(!(await openViewMenu()).some((x) => x.startsWith('Review Comments ')), `no Review without comments (${id})`);
      await press(await workbench(), 'Escape');
    }
    const file = path.join(root(), 'review-menu.txt');
    fs.writeFileSync(file, 'one\ntwo\n');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc);
    const thread = api.review.controller.createCommentThread(doc.uri, new vscode.Range(1, 0, 1, 0), []);
    try {
      await vscode.commands.executeCommand('commitCorner.review.add', { thread, text: 'Rename this.' });
      for (const id of ['worktrees', 'graphView']) {
        await vscode.commands.executeCommand(`commitCorner.sidebar.${id}`);
        await sleep(500);
        assert.ok((await openViewMenu()).includes('Review Comments []'), `Review in the ··· menu (${id})`);
        await inWorkbench(`(() => {
          const roots = [document, ...[...document.querySelectorAll('*')].filter((h) => h.shadowRoot).map((h) => h.shadowRoot)];
          const item = roots.flatMap((r) => [...r.querySelectorAll('.action-menu-item')]).find((i) => (i.querySelector('.action-label') || {}).textContent === 'Review Comments');
          item.focus();
        })()`);
        await press(await workbench(), 'ArrowRight');
        let sub;
        for (let i = 0; i < 20 && !sub; i++) {
          await sleep(100);
          sub = (await openMenus())[1];
        }
        assert.deepStrictEqual(sub, ['Copy Review for the Agent [Ctrl+Alt+G C]', 'Save Review to the Worktree []', 'Delete All Review Comments… []']);
        await press(await workbench(), 'Escape');
        await press(await workbench(), 'Escape');
      }
    } finally {
      await vscode.commands.executeCommand('commitCorner.review.deleteThread', thread);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      fs.rmSync(file, { force: true });
    }
  });
});
