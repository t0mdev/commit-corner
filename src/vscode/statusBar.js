'use strict';

const vscode = require('vscode');
const notify = require('./notify');
const { config, shortSha, log, escapeIcons } = require('./util');
const { builtInGitEnabled } = require('./scm');

/**
 * Status bar: current branch, sync state, and a prominent indicator while a
 * merge/rebase/cherry-pick/revert is in progress. Also runs auto-fetch.
 */
class StatusBar {
  /** @param {import('./model').RepositoryManager} manager */
  constructor(manager) {
    this.manager = manager;
    this.branch = vscode.window.createStatusBarItem('commitCorner.branch', vscode.StatusBarAlignment.Left, 100);
    this.branch.name = 'Commit Corner Branch';
    this.sync = vscode.window.createStatusBarItem('commitCorner.sync', vscode.StatusBarAlignment.Left, 99);
    this.sync.name = 'Commit Corner Sync';
    this.operation = vscode.window.createStatusBarItem('commitCorner.operation', vscode.StatusBarAlignment.Left, 101);
    this.operation.name = 'Commit Corner Operation';
    this.operation.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    // A write that takes long (hook, GPG pinentry, huge add) becomes visible and cancellable.
    this.busy = vscode.window.createStatusBarItem('commitCorner.busy', vscode.StatusBarAlignment.Left, 102);
    this.busy.name = 'Commit Corner: running git command';
    this.busyTimers = new Map();
    this.disposables = [
      this.branch, this.sync, this.operation, this.busy,
      manager.onDidOpen((r) => this.watchBusy(r)),
      manager.onDidChangeState((r) => {
        if (r === manager.active) this.update();
      }),
      manager.onDidChangeActive(() => this.update()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('commitCorner')) {
          this.update();
          this.scheduleAutoFetch();
        }
      }),
    ];
    for (const r of manager.repositories) this.watchBusy(r);
    this.scheduleAutoFetch();
    this.update();
  }

  watchBusy(repo) {
    repo.on('busy', (running) => {
      clearTimeout(this.busyTimers.get(repo.root));
      if (!running) {
        this.busy.hide();
        return;
      }
      this.busyTimers.set(repo.root, setTimeout(() => {
        if (repo.running !== running) return;
        this.busy.text = `$(sync~spin) git ${running.args[0]}…`;
        this.busy.tooltip = `Waiting for: git ${running.args.join(' ')}\nClick to cancel it.`;
        this.busy.command = { command: 'commitCorner.cancelGit', title: 'Cancel', arguments: [{ repoRoot: repo.root }] };
        this.busy.show();
      }, 2000));
    });
  }

  visible() {
    const v = config().get('statusBar', 'auto');
    return v === 'always' || (v === 'auto' && !builtInGitEnabled());
  }

  update() {
    const repo = this.manager.active;
    const state = repo && repo.state;
    if (!state) {
      this.branch.hide();
      this.sync.hide();
      this.operation.hide();
      return;
    }
    const arg = { repoRoot: repo.root };
    const op = state.operation;
    vscode.commands.executeCommand('setContext', 'commitCorner.bisecting', !!op && op.kind === 'bisect');
    vscode.commands.executeCommand('setContext', 'commitCorner.operationInProgress', !!op && op.kind !== 'bisect');
    if (op) {
      const progress = op.step && op.total ? ` ${op.step}/${op.total}` : '';
      const conflicts = state.conflicts.length ? ` • ${state.conflicts.length} conflict${state.conflicts.length === 1 ? '' : 's'}` : '';
      const steps = op.kind === 'bisect' && repo.bisectStepsLeft !== undefined ? ` • ~${repo.bisectStepsLeft} step${repo.bisectStepsLeft === 1 ? '' : 's'} left` : '';
      this.operation.text = op.kind === 'bisect' ? `$(search) BISECTING ${state.head.sha ? shortSha(state.head.sha) : ''}${steps}` : `$(warning) ${op.kind.toUpperCase()}${progress}${conflicts}`;
      this.operation.tooltip = `A ${op.kind} is in progress${op.head ? ` (${op.head.length >= 40 ? shortSha(op.head) : op.head})` : ''}. Click to continue, skip or abort.`;
      this.operation.command = { command: 'commitCorner.operationMenu', title: 'Operation', arguments: [arg] };
      this.operation.show();
    } else this.operation.hide();

    if (!this.visible()) {
      this.branch.hide();
      this.sync.hide();
      return;
    }
    const dirty = state.staged.length + state.unstaged.length + state.untracked.length > 0;
    const name = state.head.branch || (state.head.sha ? shortSha(state.head.sha) : 'no commits');
    this.branch.text = `$(${state.head.branch ? 'git-branch' : 'debug-disconnect'}) ${escapeIcons(name)}${dirty ? '*' : ''}`;
    this.branch.tooltip = `${this.manager.repositories.length > 1 ? `${repo.name} — ` : ''}${state.head.branch ? `Branch ${state.head.branch}` : 'Detached HEAD'}${dirty ? ' (uncommitted changes)' : ''}\nClick to check out another branch`;
    this.branch.command = { command: 'commitCorner.checkout', title: 'Checkout', arguments: [arg] };
    this.branch.show();

    if (!state.head.branch) this.sync.hide();
    else if (!state.head.upstream) {
      this.sync.text = '$(cloud-upload)';
      this.sync.tooltip = `Publish ${state.head.branch}`;
      this.sync.command = { command: 'commitCorner.push', title: 'Publish', arguments: [arg] };
      this.sync.show();
    } else {
      const { ahead, behind } = state.head;
      this.sync.text = `$(sync)${behind ? ` ${behind}↓` : ''}${ahead ? ` ${ahead}↑` : ''}`;
      this.sync.tooltip = `${state.head.upstream}: ${behind} to pull, ${ahead} to push. Click to sync.`;
      this.sync.command = { command: 'commitCorner.sync', title: 'Sync', arguments: [arg] };
      this.sync.show();
    }
  }

  scheduleAutoFetch() {
    clearInterval(this.fetchTimer);
    const minutes = config().get('autoFetchMinutes', 0);
    if (!minutes || minutes <= 0) return;
    this.fetchTimer = setInterval(() => {
      if (!vscode.window.state.focused) return;
      for (const repo of this.manager.repositories) {
        // Bounded so a dead connection cannot pile up background fetches.
        const seconds = config().get('networkTimeoutSeconds', 0) || 120;
        repo.fetch({ all: config().get('fetchAllRemotes', true), timeout: seconds * 1000, quiet: true })
          .catch((e) => log().warn(`Auto-fetch ${repo.name}: ${e.message}`));
      }
    }, Math.max(1, minutes) * 60e3);
  }

  dispose() {
    clearInterval(this.fetchTimer);
    this.disposables.forEach((d) => d.dispose());
  }
}

/** @param {import('./context').Context} ctx */
function register(ctx) {
  const bar = new StatusBar(ctx.manager);
  ctx.command('commitCorner.cancelGit', async (arg) => {
    const repo = await ctx.manager.pick(arg);
    if (!repo || !repo.running) return;
    const ok = await notify.warn(`Cancel "git ${repo.running.args.join(' ')}"?`, { modal: true, detail: 'The git process is stopped; whatever it already did stays done.' }, 'Stop It');
    if (ok && repo.running) repo.running.cancel();
  });

  ctx.command('commitCorner.operationMenu', async (arg) => {
    const repo = await ctx.manager.pick(arg);
    if (!repo) return;
    const op = (await repo.refreshState()).operation;
    if (!op) return;
    const items = op.kind === 'bisect' ? [
      { label: '$(pass) Good', description: 'the current commit does not have the bug', id: 'commitCorner.bisectGood' },
      { label: '$(error) Bad', description: 'the current commit has the bug', id: 'commitCorner.bisectBad' },
      { label: '$(debug-step-over) Skip', description: 'this commit cannot be tested', id: 'commitCorner.bisectSkip' },
      { label: '$(debug-stop) End Bisect', description: 'return to where you started', id: 'commitCorner.bisectReset' },
    ] : [
      { label: '$(debug-continue) Continue', id: 'commitCorner.continueOperation' },
      ...(['rebase', 'cherry-pick', 'revert'].includes(op.kind) ? [{ label: '$(debug-step-over) Skip this commit', id: 'commitCorner.skipOperation' }] : []),
      { label: '$(debug-stop) Abort', id: 'commitCorner.abortOperation' },
      { label: '$(source-control) Open Source Control', id: 'workbench.view.scm' },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: op.kind === 'bisect' ? 'Bisecting: is the checked-out commit good or bad?' : `${op.kind} in progress` });
    if (pick) await vscode.commands.executeCommand(pick.id, repo);
  });
  return bar;
}

module.exports = { register, StatusBar };
