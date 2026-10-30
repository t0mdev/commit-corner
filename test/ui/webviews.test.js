'use strict';

/**
 * The webviews in a real VS Code, driven through their DOM (test/ui/cdp.js): the graph's staging
 * area (keys, focus, the commit message across reloads, ✨ with a test language model, Enter
 * commits) and the summary page. Workspace: .vscode-test.mjs "ui" (a dirty working tree, and an
 * agent worktree next to it).
 */

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
const vscode = require('vscode');
const { evaluate, webview, press } = require('./cdp');
const { COMMIT } = require('./fakelm/extension');

const pkg = require('../../package.json');

const root = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
const git = (...args) => execFileSync('git', args, { cwd: root(), encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
}

/** Press a key on an element of the page (or the focused one), the way the page listens for it. */
function key(page, selector, k, mods = {}) {
  const target = selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document.activeElement';
  return evaluate(page, `(() => {
    const el = ${target};
    if (!el) throw new Error('no element ${selector || ''}');
    el.focus();
    const e = new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ctrlKey: ${!!mods.ctrl}, shiftKey: ${!!mods.shift} });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  })()`);
}

const focused = (page) => evaluate(page, `(() => { const a = document.activeElement; return { cls: a.className, fkey: a.dataset.fkey || null, key: a.dataset.key || null }; })()`);
const box = '.commit-message';

suite('Webviews in VS Code (DOM)', () => {
  let page;

  suiteSetup(async function () {
    this.timeout(120000);
    const api = await vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`).activate();
    await until(() => api.manager.repositories.length >= 1, 'the workspace repository');
    await vscode.commands.executeCommand('commitCorner.showGraph');
    page = await webview('graph.js', "!document.body.classList.contains('in-sidebar') && document.querySelectorAll('.row').length > 2");
    // The uncommitted changes are the first row: open them (→).
    await key(page, '.scroller, [role=tree]', 'Home');
    await key(page, null, 'ArrowRight');
    await until(() => evaluate(page, `!!document.querySelector('${box}') && document.querySelectorAll('.files-block .file-line.file').length >= 3`), 'the staging area');
  });

  test('+ stages a file and the keyboard goes to the next file of the same group', async () => {
    await key(page, '.file-line.file[data-fkey="unstaged:a.txt"]', '+');
    await until(() => git('diff', '--cached', '--name-only').split('\n').includes('a.txt'), 'a.txt staged');
    await until(async () => (await focused(page)).fkey === 'unstaged:b.txt', 'focus on b.txt (same group)', 8000)
      .catch(async (e) => assert.fail(`${e.message}; focus is ${JSON.stringify(await focused(page))}`));
  });

  test('the commit message survives a reload of the graph, and Ctrl+A stays in the box', async () => {
    await evaluate(page, `(() => { const i = document.querySelector('${box}'); i.focus(); i.value = 'Work in progress'; i.dispatchEvent(new Event('input', { bubbles: true })); i.setSelectionRange(4, 4); return true; })()`);
    const loads = Number(await evaluate(page, `document.body.dataset.loads || 0`));
    git('branch', 'moved-ref'); // a ref moves: the graph loads again
    await until(async () => Number(await evaluate(page, `document.body.dataset.loads || 0`)) > loads, 'the graph to load again');
    await sleep(300);
    const after = await evaluate(page, `(() => { const i = document.querySelector('${box}'); return { value: i.value, caret: i.selectionStart, focused: document.activeElement === i }; })()`);
    assert.deepStrictEqual(after, { value: 'Work in progress', caret: 4, focused: true });
    const selected = () => evaluate(page, `document.querySelectorAll('.row.selected').length`);
    const before = await selected();
    // A real Ctrl+A (through VS Code's key handling): the text is selected, not the commits.
    await evaluate(page, `(document.querySelector('${box}').focus(), true)`);
    await press(page, 'a', { ctrl: true });
    await sleep(300);
    assert.strictEqual(await selected(), before, 'the commit selection is unchanged');
    assert.deepStrictEqual(await evaluate(page, `(() => { const i = document.querySelector('${box}'); return [i.selectionStart, i.selectionEnd]; })()`), [0, 'Work in progress'.length], 'all of the text is selected');
  });

  test('✨ writes the message with the language model', async () => {
    const models = await until(() => vscode.lm.selectChatModels().then((m) => m.length && m), 'the test language model', 15000)
      .catch(async () => assert.fail(`no language model; extensions: ${vscode.extensions.all.filter((x) => !x.id.startsWith('vscode.')).map((x) => `${x.id}${x.isActive ? '*' : ''}`).join(', ')}`));
    assert.strictEqual(models[0].vendor, 'cc-test');
    await evaluate(page, `(document.querySelector('button.generate').click(), true)`);
    await until(() => evaluate(page, `document.querySelector('${box}').value === ${JSON.stringify(COMMIT)}`), 'the generated message');
    await until(() => evaluate(page, `!document.querySelector('.commit-box').classList.contains('busy')`), 'the box to take input again');
    // One edit: undo brings back what was typed before.
    assert.strictEqual(await evaluate(page, `(document.querySelector('${box}').focus(), document.execCommand('undo'), document.querySelector('${box}').value)`), 'Work in progress');
    // (The generated text again, for the commit below.)
    await evaluate(page, `(() => { const i = document.querySelector('${box}'); i.focus(); i.select(); document.execCommand('insertText', false, ${JSON.stringify(COMMIT)}); return i.value; })()`);
    await until(() => evaluate(page, `document.querySelector('${box}').value === ${JSON.stringify(COMMIT)}`), 'the message back');
  });

  test('Enter in the message commits the staged changes', async () => {
    const staged = git('diff', '--cached', '--name-only').split('\n').sort();
    await evaluate(page, `(document.querySelector('${box}').focus(), true)`);
    await press(page, 'Enter'); // a real Enter
    await until(() => git('log', '-1', '--format=%s') === COMMIT.split('\n')[0], 'the commit');
    assert.deepStrictEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), staged);
    await until(() => evaluate(page, `document.querySelector('${box}').value === ''`), 'the box to be cleared');
    // The new commit arrives in the graph with a short highlight; the box says where commits go.
    await until(() => evaluate(page, `!!document.querySelector('.row.arrived')`), 'the new commit highlighted', 8000);
    assert.match(await evaluate(page, `document.querySelector('${box}').placeholder`), /"main"/);
  });

  test('a summary is shown as text: markup in the answer stays text', async () => {
    const agent = `${root()}-agent`;
    await vscode.commands.executeCommand('commitCorner.worktreeSummarize', { repoRoot: root(), worktreePath: agent, worktree: { branch: 'agent', path: agent } });
    const summary = await webview('summary.js');
    await until(() => evaluate(summary, `!!document.querySelector('.answer h3, .answer .error')`), 'the summary page to show something')
      .catch(async (e) => assert.fail(`${e.message}: ${await evaluate(summary, `JSON.stringify({ title: document.querySelector('.title').textContent, status: document.querySelector('.status').textContent, answer: document.querySelector('.answer').textContent, foot: document.querySelector('.foot').textContent })`)}`));
    const error = await evaluate(summary, `document.querySelector('.answer .error') && document.querySelector('.answer .error').textContent`);
    assert.ok(!error, `the summary failed: ${error}`);
    await until(() => evaluate(summary, `!!document.querySelector('.foot').textContent`), 'the summary to finish');
    const shown = await evaluate(summary, `({ h3: [...document.querySelectorAll('.answer h3')].map((h) => h.textContent), imgs: document.querySelectorAll('.answer img').length, text: document.querySelector('.answer').textContent, title: document.title })`);
    assert.deepStrictEqual(shown.h3, ['What changed', 'Looks risky', 'Review first']);
    assert.strictEqual(shown.imgs, 0, 'no element from the answer');
    assert.match(shown.text, /<img src=x onerror=/, 'the markup is visible as text');
    assert.notStrictEqual(shown.title, 'pwned');
    // The keyboard is on the answer (arrows and Page Down read it).
    await until(() => evaluate(summary, `document.hasFocus() && document.activeElement === document.querySelector('.answer')`), 'the summary to have the keyboard', 5000);
    assert.ok(path.isAbsolute(agent));
    assert.match(await evaluate(summary, `document.querySelector('.foot').textContent`), /^Written by Test LM \(cc-test\) from/);
  });

  test('an empty answer says so on the page, with Choose Model and Show Log', async () => {
    const agent = `${root()}-agent`;
    const config = vscode.workspace.getConfiguration('commitCorner');
    await config.update('ai.modelFamily', 'cc-test-silent', vscode.ConfigurationTarget.Global);
    try {
      await vscode.commands.executeCommand('commitCorner.worktreeSummarize', { repoRoot: root(), worktreePath: agent, worktree: { branch: 'agent', path: agent } });
      const summary = await webview('summary.js');
      const error = await until(() => evaluate(summary, `document.querySelector('.answer .error') && document.querySelector('.answer .error').textContent`), 'the empty answer to be reported');
      assert.match(error, /^Silent LM \(cc-test\) sent an empty answer\./);
      assert.deepStrictEqual(await evaluate(summary, `[...document.querySelectorAll('.answer .fix button')].map((b) => b.textContent)`), ['Choose Model…', 'Show Log']);
      // Only a tool call: named in words (VS Code's own class names are minified).
      await config.update('ai.modelFamily', 'cc-test-tool', vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('commitCorner.worktreeSummarize', { repoRoot: root(), worktreePath: agent, worktree: { branch: 'agent', path: agent } });
      const tool = await until(() => evaluate(summary, `(document.querySelector('.answer .error') || {}).textContent || ''`).then((t) => /Tool LM/.test(t) && t), 'the tool-call-only answer to be reported');
      assert.match(tool, /^Tool LM \(cc-test\) sent an empty answer \(only 1 × tool call\)\./);
    } finally {
      await config.update('ai.modelFamily', undefined, vscode.ConfigurationTarget.Global);
    }
  });
});

suite('One draft (graph and Source Control)', () => {
  test('typing in the graph\'s box fills Source Control\'s message box', async () => {
    const api = await vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`).activate();
    const repo = api.manager.repositories[0];
    await vscode.commands.executeCommand('commitCorner.showGraph'); // in front again (the summary was)
    const page = await webview('graph.js', "!document.body.classList.contains('in-sidebar') && document.querySelectorAll('.row').length > 2");
    if (!(await evaluate(page, `!!document.querySelector('.commit-message')`))) {
      await key(page, '.scroller, [role=tree]', 'Home');
      await key(page, null, 'ArrowRight');
      await until(() => evaluate(page, `!!document.querySelector('.commit-message')`), 'the staging area');
    }
    await evaluate(page, `(() => { const i = document.querySelector('.commit-message'); i.focus(); i.value = 'Shared draft'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await until(() => api.scm.get(repo).message === 'Shared draft', 'Source Control to show the draft', 5000);
  });
});

suite('VS Code chords in the graph', () => {
  test('Ctrl+Alt+G W in the message opens the worktrees overview and types nothing', async () => {
    await vscode.commands.executeCommand('commitCorner.showGraph');
    await sleep(1500); // the page is re-created when its tab comes back
    const page = await webview('graph.js', "!document.body.classList.contains('in-sidebar') && !!document.querySelector('.commit-message')");
    await evaluate(page, `(() => { const i = document.querySelector('.commit-message'); i.focus(); i.value = 'Chord test'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const step = (name, p) => p.catch((e) => assert.fail(`${name}: ${e && (e.message || e.type || JSON.stringify(e))}`));
    await step('press Ctrl+Alt+G', press(page, 'g', { ctrl: true, alt: true }));
    await step('press W', press(page, 'w'));
    const opened = await webview('worktrees.js', 'true', 8000).then(() => true, () => false);
    assert.ok(opened, 'VS Code still got the chord (the worktrees overview opened)');
    // The overview hid the graph's tab: back to it, its draft restored — without a "w".
    await vscode.commands.executeCommand('commitCorner.showGraph');
    await sleep(1500);
    const again = await webview('graph.js', "!document.body.classList.contains('in-sidebar') && document.querySelectorAll('.row').length > 2");
    if (!(await evaluate(again, `!!document.querySelector('.commit-message')`))) {
      await key(again, '.scroller, [role=tree]', 'Home');
      await key(again, null, 'ArrowRight');
    }
    await until(() => evaluate(again, `!!document.querySelector('.commit-message')`), 'the staging area');
    assert.strictEqual(await evaluate(again, `document.querySelector('.commit-message').value`), 'Chord test', 'no "w" typed');
  });
});

suite('The uncommitted changes row', () => {
  test('stays clean right after a commit (Amend and Undo at hand), and goes when the last change is discarded', async () => {
    await vscode.commands.executeCommand('commitCorner.showGraph');
    await sleep(1500);
    const page = await webview('graph.js', "!document.body.classList.contains('in-sidebar') && document.querySelectorAll('.row').length > 2");
    if (!(await evaluate(page, `!!document.querySelector('${box}')`))) {
      await key(page, '.scroller, [role=tree]', 'Home');
      await key(page, null, 'ArrowRight');
    }
    await until(() => evaluate(page, `!!document.querySelector('${box}')`), 'the staging area');
    // Everything committed from the box: the tree is clean, the row stays.
    git('add', '-A');
    await evaluate(page, `(() => { const i = document.querySelector('${box}'); i.focus(); i.value = 'Commit everything'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await press(page, 'Enter');
    await until(() => git('log', '-1', '--format=%s') === 'Commit everything' && !git('status', '--porcelain'), 'the commit, and a clean tree');
    await until(() => evaluate(page, `document.querySelector('${box}').value === ''`), 'the box to be cleared');
    await sleep(1200); // the graph loads again after the commit
    assert.ok(await evaluate(page, `!!document.querySelector('.row.worktree') && !!document.querySelector('${box}')`), 'the staging area stays after the commit');
    // A new change, then discarded: clean again, and this time the row goes.
    require('fs').writeFileSync(path.join(root(), 'a.txt'), 'changed again\n');
    await until(() => evaluate(page, `/1/.test((document.querySelector('.row.worktree .wt-summary') || {}).textContent || '')`), 'the change in the row');
    git('checkout', '-q', '--', 'a.txt');
    await until(() => evaluate(page, `!document.querySelector('.row.worktree') && !document.querySelector('${box}')`), 'the row to go', 8000)
      .catch(async (e) => assert.fail(`${e.message}: ${await evaluate(page, `(document.querySelector('.row.worktree') || {}).textContent || 'no row'`)}`));
  });
});

suite('A commit\'s files in the graph', () => {
  /** Expand the row with this subject and wait for its file lines. */
  async function expand(page, subject) {
    await until(() => evaluate(page, `(() => {
      const row = [...document.querySelectorAll('.row')].find((r) => (r.querySelector('.subject') || {}).textContent === ${JSON.stringify(subject)});
      if (!row) return false;
      if (!row.querySelector('.twisty.open')) row.querySelector('.twisty').click();
      return true;
    })()`), `the row "${subject}"`);
    await until(() => evaluate(page, `(() => {
      const row = [...document.querySelectorAll('.row')].find((r) => (r.querySelector('.subject') || {}).textContent === ${JSON.stringify(subject)});
      const box = row && document.getElementById(row.getAttribute('aria-owns') || '');
      return !!box && box.querySelectorAll('.file-line.file[data-vk]').length > 0;
    })()`), 'its files');
    // Selectors inside that commit only (another open commit or the staging area must not count).
    return evaluate(page, `(() => { const row = [...document.querySelectorAll('.row')].find((r) => (r.querySelector('.subject') || {}).textContent === ${JSON.stringify(subject)}); return { files: '#' + row.getAttribute('aria-owns'), row: '#' + row.id }; })()`);
  }

  test('are bold until opened; then the row counts them viewed, and O opens the working file', async () => {
    // The sidebar graph: it stays on screen while the diffs open in the editor.
    await vscode.commands.executeCommand('commitCorner.graphView.focusList');
    const page = await webview('graph.js', "document.body.classList.contains('in-sidebar') && document.querySelectorAll('.row').length > 2");
    const at = await expand(page, 'Change two');
    const line = `${at.files} .file-line.file[data-vk]`;
    const weight = () => evaluate(page, `Number(getComputedStyle(document.querySelector('${line} .name')).fontWeight)`);
    assert.ok(await evaluate(page, `document.querySelector('${line}').classList.contains('unviewed')`), 'not opened yet');
    assert.ok((await weight()) >= 700, 'bold');
    await key(page, line, 'Enter');
    await until(() => evaluate(page, `!document.querySelector('${line}').classList.contains('unviewed')`), 'not bold once opened');
    // (Its row is redrawn: looked up again by its subject.)
    await until(() => evaluate(page, `[...document.querySelectorAll('.row')].some((r) => (r.querySelector('.subject') || {}).textContent === 'Change two' && r.querySelector('.viewed-count'))`), 'the row counts it viewed');
    // O: the file as it is now, in a normal editor.
    await key(page, line, 'o');
    await until(() => {
      const ed = vscode.window.activeTextEditor;
      return ed && ed.document.uri.scheme === 'file' && ed.document.uri.fsPath.endsWith('a.txt');
    }, 'the working a.txt in an editor').catch((e) => assert.fail(`${e.message}; active: ${vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.toString()}`));
    // The right-click menu offers "Mark as Not Viewed" now (park it for later).
    assert.strictEqual(await evaluate(page, `JSON.parse(document.querySelector('${line}').dataset.vscodeContext).unviewed`), false);
    // V: not viewed again.
    await key(page, line, 'v');
    await until(() => evaluate(page, `document.querySelector('${line}').classList.contains('unviewed')`), 'bold again after V');
  });

  test('in the sidebar, the ▸ comes first and the files are indented under it', async () => {
    await vscode.commands.executeCommand('commitCorner.graphView.focusList');
    const page = await webview('graph.js', "document.body.classList.contains('in-sidebar') && document.querySelectorAll('.row').length > 2");
    await expand(page, 'Change two');
    const at = await evaluate(page, `(() => {
      const row = [...document.querySelectorAll('.row')].find((r) => (r.querySelector('.subject') || {}).textContent === 'Change two');
      const tw = row.querySelector('.twisty').getBoundingClientRect();
      const date = row.querySelector('.cell.date').getBoundingClientRect();
      const file = document.getElementById(row.getAttribute('aria-owns')).querySelector('.file-line.file .status').getBoundingClientRect();
      return { twisty: tw.left, date: date.left, file: file.left };
    })()`);
    assert.ok(at.twisty < at.date, `▸ before the age: ${JSON.stringify(at)}`);
    assert.ok(at.file > at.twisty + 4 && at.file < at.twisty + 30, `files one step in from the ▸: ${JSON.stringify(at)}`);
  });
});

suite('Graph: collapse all, and viewed marks of the uncommitted changes', () => {
  test('Collapse All closes every expanded commit', async () => {
    await vscode.commands.executeCommand('commitCorner.graphView.focusList');
    const page = await webview('graph.js', "document.body.classList.contains('in-sidebar') && document.querySelectorAll('.row').length > 2");
    for (const subject of ['Change two', 'Initial commit']) {
      await evaluate(page, `(() => { const row = [...document.querySelectorAll('.row')].find((r) => (r.querySelector('.subject') || {}).textContent === ${JSON.stringify(subject)}); if (row && !row.querySelector('.twisty.open')) row.querySelector('.twisty').click(); return true; })()`);
    }
    await until(() => evaluate(page, `document.querySelectorAll('.files-block').length >= 2`), 'two commits open');
    await vscode.commands.executeCommand('commitCorner.graphView.collapseAll');
    await until(() => evaluate(page, `document.querySelectorAll('.files-block').length === 0 && !document.querySelector('.twisty.open')`), 'all closed');
    assert.ok(await evaluate(page, `!!document.querySelector('.top-bar .view-switch')`), 'the view switcher is at the top');
  });

  test('an uncommitted file is bold until opened, and bold again when it changes', async () => {
    const fs = require('fs');
    const file = path.join(root(), 'a.txt');
    const line = '.files-block .file-line.file[data-fkey="unstaged:a.txt"]';
    try {
      fs.writeFileSync(file, 'viewed test 1\n');
      await vscode.commands.executeCommand('commitCorner.graphView.focusList');
      const page = await webview('graph.js', "document.body.classList.contains('in-sidebar') && document.querySelectorAll('.row').length > 2");
      await vscode.commands.executeCommand('commitCorner.refresh');
      await until(() => evaluate(page, `!!document.querySelector('.row.worktree')`), 'the uncommitted changes row');
      await evaluate(page, `(() => { const row = document.querySelector('.row.worktree'); if (!row.querySelector('.twisty.open')) row.querySelector('.twisty').click(); return true; })()`);
      await until(() => evaluate(page, `!!document.querySelector('${line}[data-vk].unviewed')`), 'a.txt bold');
      await key(page, line, 'Enter');
      await until(() => evaluate(page, `!document.querySelector('${line}').classList.contains('unviewed')`), 'not bold once opened');
      fs.writeFileSync(file, 'viewed test 2, changed again\n');
      await vscode.commands.executeCommand('commitCorner.refresh'); // as the file watcher would
      await until(() => evaluate(page, `!!document.querySelector('${line}.unviewed')`), 'bold again after the change', 20000);
    } finally {
      git('checkout', '-q', '--', 'a.txt');
    }
  });
});

suite('The editor graph opens diffs beside itself', () => {
  test('Space on a commit\'s file keeps the graph (and its keyboard) on screen', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('commitCorner.showGraph');
    const page = await webview('graph.js', "!document.body.classList.contains('in-sidebar') && document.querySelectorAll('.row').length > 2");
    await evaluate(page, `(() => { const row = [...document.querySelectorAll('.row')].find((r) => (r.querySelector('.subject') || {}).textContent === 'Change two'); if (!row.querySelector('.twisty.open')) row.querySelector('.twisty').click(); return true; })()`);
    await until(() => evaluate(page, `document.querySelectorAll('.files-block .file-line.file').length > 0`), 'its files');
    await key(page, '.files-block .file-line.file', ' ');
    await until(() => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputTextDiff)), 'the diff');
    const graphTab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.label === 'Commit Graph');
    assert.ok(graphTab, 'the graph tab is still open');
    const diffTab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputTextDiff);
    assert.notStrictEqual(diffTab.group.viewColumn, graphTab.group.viewColumn, 'the diff is beside it, in another group');
    // N: the next file not viewed yet of that commit gets the keyboard, its diff opens beside.
    await evaluate(page, `(() => { const row = [...document.querySelectorAll('.row')].find((r) => (r.querySelector('.subject') || {}).textContent === 'Initial commit'); if (!row.querySelector('.twisty.open')) row.querySelector('.twisty').click(); return true; })()`);
    const box = await until(() => evaluate(page, `(() => { const row = [...document.querySelectorAll('.row')].find((r) => (r.querySelector('.subject') || {}).textContent === 'Initial commit'); const b = row && document.getElementById(row.getAttribute('aria-owns') || ''); return b && b.querySelectorAll('.file-line.file[data-vk]').length === 2 ? '#' + b.id : ''; })()`), 'Initial commit\'s files');
    await key(page, `${box} .file-line.file[data-fkey=":a.txt"]`, 'n');
    await until(() => evaluate(page, `document.activeElement && document.activeElement.dataset.fkey === ':b.txt'`), 'N moved to b.txt');
    // (The graph is redrawn narrower once the diff is beside it: looked up again each time.)
    await until(() => evaluate(page, `(() => { const l = document.querySelector('.file-line.file[data-vk][data-fkey=":b.txt"]'); return !!l && !l.classList.contains('unviewed'); })()`), 'b.txt opened (no longer bold)');
    assert.ok(await evaluate(page, `!!document.querySelector('.files-block .file-line.file')`), 'and its page is alive');
  });
});
