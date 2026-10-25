'use strict';

const vscode = require('vscode');
const notify = require('../notify');
const path = require('path');
const fs = require('fs');
const { Repository } = require('../../git/repository');
const { pickRef } = require('../pickers');
const { shortSha, withProgress, confirm, selectedShas, escapeIcons, formatDate, showError } = require('../util');
const { runConflicting } = require('./branchCommands');

/**
 * Repository-level commands: init, clone, submodules, bisect and patches.
 */

/** @param {import('../context').Context} ctx */
function register(ctx) {
  const { manager } = ctx;
  const cmd = ctx.command;

  // ---- init / clone ---------------------------------------------------------

  cmd('commitCorner.init', async () => {
    const folders = vscode.workspace.workspaceFolders || [];
    let dir;
    if (folders.length === 1) dir = folders[0].uri.fsPath;
    else if (folders.length > 1) {
      const pick = await vscode.window.showQuickPick(folders.map((f) => ({ label: f.name, description: f.uri.fsPath, dir: f.uri.fsPath })), { placeHolder: 'Initialize a repository in…' });
      dir = pick && pick.dir;
    } else {
      const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Initialize Repository' });
      dir = pick && pick[0] && pick[0].fsPath;
    }
    if (!dir) return;
    const repo = await Repository.init(dir);
    // The folder as VS Code names it (git's spelling of it differs on Windows: "C:/…").
    const opened = repo && (await manager.openRepository(dir));
    if (opened) manager.setActive(opened);
    if (!folders.length) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir));
  });

  cmd('commitCorner.clone', async (urlArg) => {
    const url = typeof urlArg === 'string' ? urlArg : await vscode.window.showInputBox({ prompt: 'Repository URL', placeHolder: 'git@github.com:owner/repo.git' });
    if (!url) return;
    const parent = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Clone Here' });
    if (!parent || !parent[0]) return;
    const name = url.replace(/[/\\]+$/, '').split(/[/:]/).pop().replace(/\.git$/, '') || 'repository';
    const dir = path.join(parent[0].fsPath, name);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
      notify.error(`${dir} already exists and is not empty.`);
      return;
    }
    await withProgress(`Cloning ${url}…`, (signal) => Repository.clone(url, dir, { signal }));
    const choice = await notify.info(`Cloned into ${dir}.`, 'Open', 'Open in New Window', 'Add to Workspace');
    if (choice === 'Open') await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir));
    else if (choice === 'Open in New Window') await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir), { forceNewWindow: true });
    else if (choice) vscode.workspace.updateWorkspaceFolders((vscode.workspace.workspaceFolders || []).length, 0, { uri: vscode.Uri.file(dir) });
  });

  cmd('commitCorner.updateSubmodules', async (arg) => {
    const repo = await manager.pick(arg);
    if (repo) await withProgress('Updating submodules…', () => repo.updateSubmodules());
  });

  // ---- bisect ---------------------------------------------------------------

  /**
   * The stash "Stash & Bisect" made, offered back when the bisect ends — kept in the git dir
   * (not in memory), so a window reload in between does not forget it.
   */
  const bisectStashFile = (repo) => path.join(repo.gitDir, 'commit-corner-bisect-stash');
  const bisectStashes = {
    get: (repo) => {
      try {
        const sha = fs.readFileSync(bisectStashFile(repo), 'utf8').trim();
        return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
      } catch {
        return undefined;
      }
    },
    set: (repo, sha) => fs.writeFileSync(bisectStashFile(repo), `${sha}\n`),
    delete: (repo) => fs.rmSync(bisectStashFile(repo), { force: true }),
  };

  /** End the bisect, then offer the changes stashed before it back. */
  async function endBisect(repo) {
    await repo.bisectReset();
    await offerBisectStash(repo, 'Bisect ended.');
  }

  async function offerBisectStash(repo, what) {
    const sha = bisectStashes.get(repo);
    bisectStashes.delete(repo);
    const stash = sha && (await repo.getStashes()).find((s) => s.sha === sha);
    if (!stash) return;
    // Modal, like the question at the start: your changes are waiting, keyboard users included.
    const choice = await notify.info(`${what} Bring back the changes stashed before it?`, { modal: true, detail: `They are in the stash "Commit Corner: before bisect".` }, 'Pop Stash', 'Keep in Stash');
    if (choice !== 'Pop Stash') return;
    const now = (await repo.getStashes()).find((s) => s.sha === sha);
    if (now) await repo.stashApply(now.ref, true);
  }

  /** The "good" end: recent commits of the bad one first (any other revision on request). */
  async function pickGood(repo, bad) {
    const commits = (await repo.log({ revs: [bad], maxCount: 50, firstParent: true }).catch(() => [])).slice(1);
    const other = { label: '$(git-branch) Branch, tag or other revision…', alwaysShow: true };
    const pick = await vscode.window.showQuickPick([
      ...commits.map((c) => ({ label: escapeIcons(c.subject), description: `${shortSha(c.sha)} • ${escapeIcons(c.authorName)} • ${formatDate(c.authorDate)}`, sha: c.sha })),
      other,
    ], { title: 'Bisect (2/2)', placeHolder: `A commit that does NOT have the problem (good) — recent commits of ${bad}`, matchOnDescription: true });
    if (!pick) return undefined;
    if (pick === other) return pickRef(repo, { placeHolder: 'Bisect (2/2): a commit that does NOT have the problem (good)', exclude: [bad] });
    return pick.sha;
  }

  async function report(repo, result) {
    if (!result.done) {
      const left = /Bisecting: (.*)$/m.exec(result.output);
      // "… (roughly 3 steps)": kept for the BISECTING status bar item until the bisect ends.
      const steps = /roughly (\d+) steps?/.exec(result.output);
      repo.bisectStepsLeft = steps ? Number(steps[1]) : undefined;
      vscode.window.setStatusBarMessage(`Commit Corner: ${left ? left[1] : 'next commit checked out'}`, 8000);
      return;
    }
    repo.bisectStepsLeft = undefined;
    const c = await repo.getCommit(result.culprit);
    // Modal: every choice is reachable with Tab / arrows (a toast offers only its first button by keyboard).
    const choice = await notify.info(`First bad commit: ${shortSha(c.sha)} "${c.subject}" by ${c.authorName}.`, { modal: true, detail: 'The bisect stays active until you end it.' }, 'Show Changes', 'Show in Graph', 'End Bisect');
    const node = { repoRoot: repo.root, sha: c.sha };
    if (choice === 'Show Changes') await vscode.commands.executeCommand('commitCorner.showCommit', node);
    else if (choice === 'Show in Graph') await vscode.commands.executeCommand('commitCorner.showGraph', { repoRoot: repo.root, revealSha: c.sha });
    else if (choice === 'End Bisect') await endBisect(repo);
  }

  cmd('commitCorner.bisectStart', async (node) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const state = await repo.refreshState();
    if (state.operation) {
      notify.warn(`A ${state.operation.kind} is in progress; finish it first.`);
      return;
    }
    // Bisect checks out other commits. One question, once both ends are chosen (cancelling a
    // picker leaves everything as it was): start, stashing uncommitted changes first if any.
    let dirty = state.staged.length + state.unstaged.length;
    let good = node && node.sha;
    const fromCommit = !!good; // from a commit's menu: nothing chosen yet, so ask
    let bad = 'HEAD';
    if (!good) {
      bad = await pickRef(repo, { placeHolder: 'Bisect (1/2): a commit that HAS the problem (bad)', head: true });
      if (!bad) return;
      good = await pickGood(repo, bad);
      if (!good) return;
    }
    // Looked at again now: files may have changed while you picked (an agent at work).
    const now = await repo.refreshState();
    dirty = now.staged.length + now.unstaged.length;
    const action = dirty ? 'Stash & Bisect' : 'Start Bisect';
    const detail = `Git checks out commits in between; mark each one good or bad until the commit that introduced the problem is found.${dirty ? ` Your ${dirty} uncommitted change${dirty === 1 ? ' is' : 's are'} stashed first and offered back when the bisect ends.` : ''}`;
    // Both ends picked and nothing to stash: the pickers were the question.
    if ((fromCommit || dirty) && !(await confirm(`Bisect between ${/^[0-9a-f]{40,64}$/.test(good) ? shortSha(good) : good} (good) and ${bad} (bad)?`, action, detail))) return;
    // A marker left by a bisect that was ended outside (a terminal) is not this bisect's.
    bisectStashes.delete(repo);
    if (dirty) {
      const before = new Set((await repo.getStashes()).map((s) => s.sha));
      await repo.stashPush({ message: 'Commit Corner: before bisect' });
      const ours = (await repo.getStashes()).find((s) => !before.has(s.sha));
      if (ours) bisectStashes.set(repo, ours.sha);
    }
    try {
      await repo.bisectStart(bad, good);
    } catch (e) {
      // Not started (a file in the way, a bad revision): the stash would otherwise be forgotten.
      await showError(e, 'Bisect');
      await offerBisectStash(repo, 'The bisect did not start.');
      return;
    }
    notify.info('Bisect started. Test the checked-out commit, then mark it: Ctrl+Alt+G Shift+G good, Shift+X bad, Shift+K skip (also in the status bar and Actions, Ctrl+Alt+G Space).');
  });

  const mark = (verdict) => async (node) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    await report(repo, await repo.bisectMark(verdict, node && node.sha));
  };
  cmd('commitCorner.bisectGood', mark('good'));
  cmd('commitCorner.bisectBad', mark('bad'));
  cmd('commitCorner.bisectSkip', mark('skip'));
  cmd('commitCorner.bisectReset', async (arg) => {
    const repo = await manager.pick(arg);
    if (repo) await endBisect(repo);
  });

  // ---- patches --------------------------------------------------------------

  async function deliverPatch(text, suggestedName) {
    const choice = await vscode.window.showQuickPick(['Copy to Clipboard', 'Save to File…', 'Open in Editor'], { placeHolder: 'Patch created' });
    if (choice === 'Copy to Clipboard') await vscode.env.clipboard.writeText(text);
    else if (choice === 'Open in Editor') {
      const doc = await vscode.workspace.openTextDocument({ content: text, language: 'diff' });
      await vscode.window.showTextDocument(doc);
    } else if (choice) {
      const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(require('os').homedir(), suggestedName)), filters: { Patches: ['patch', 'diff'] } });
      if (target) await vscode.workspace.fs.writeFile(target, Buffer.from(text));
    }
  }

  cmd('commitCorner.createPatch', async (node, nodes) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const shas = selectedShas(node, nodes);
    if (shas && shas.length) {
      await deliverPatch(await repo.formatPatch(shas), shas.length === 1 ? `${shortSha(shas[0])}.patch` : `${shas.length}-commits.patch`);
      return;
    }
    const which = await vscode.window.showQuickPick([
      { label: 'All uncommitted changes', description: 'staged + unstaged, tracked files (new files: stage them first)', id: 'all' },
      { label: 'Staged changes', id: 'staged' },
      { label: 'Unstaged changes', id: 'unstaged' },
    ], { placeHolder: 'Create a patch from…' });
    if (!which) return;
    const text = await repo.diffPatch(which.id);
    if (!text.trim()) {
      notify.info('There are no changes to put in a patch.');
      return;
    }
    await deliverPatch(text, `${which.id}-changes.patch`);
  });

  cmd('commitCorner.applyPatch', async (arg) => {
    const repo = await manager.pick(arg);
    if (!repo) return;
    const source = await vscode.window.showQuickPick(['From Clipboard', 'From File…'], { placeHolder: 'Apply a patch' });
    if (!source) return;
    let text;
    if (source === 'From Clipboard') text = await vscode.env.clipboard.readText();
    else {
      const file = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Patches: ['patch', 'diff', 'mbox', 'eml'], 'All files': ['*'] } });
      if (!file || !file[0]) return;
      text = Buffer.from(await vscode.workspace.fs.readFile(file[0])).toString('utf8');
    }
    if (!/^(diff --git|--- |From [0-9a-f]{40,64})/m.test(text || '')) {
      notify.error('That does not look like a patch.');
      return;
    }
    const isMail = /^From [0-9a-f]{40,64} /m.test(text); // SHA-1 or SHA-256
    const asCommits = isMail && (await vscode.window.showQuickPick(['Apply as commits (git am)', 'Apply to the working tree only'], { placeHolder: 'The patch contains commits' })) === 'Apply as commits (git am)';
    await runConflicting(repo, 'Applying patch…', () => repo.applyPatch(text, asCommits), asCommits ? 'am' : 'patch');
  });

}

module.exports = { register };
