'use strict';

const vscode = require('vscode');
const { webviewHtml } = require('./html');
const { debounce, showError, log, validMessageShas, inThisWindow, closeStaleWebviewTabs } = require('../util');
const { onDidChangeWorktrees } = require('../views/worktreesView');

/** What the overview's buttons may run, with the worktree as the command argument. */
const ACTIONS = {
  open: 'commitCorner.worktreeOpen',
  openHere: 'commitCorner.worktreeOpenHere',
  addToWorkspace: 'commitCorner.worktreeAddToWorkspace',
  lock: 'commitCorner.worktreeLock',
  unlock: 'commitCorner.worktreeUnlock',
  remove: 'commitCorner.worktreeRemove',
  changesVsBase: 'commitCorner.worktreeChangesVsBase',
};

/**
 * Worktrees overview: one card per worktree with its branch, uncommitted
 * changes, ahead/behind, the commit checked out there and actions.
 */
class WorktreesPanel {
  /** @param {import('../context').Context} ctx */
  static async show(ctx, repo) {
    if (WorktreesPanel.current) {
      WorktreesPanel.current.repo = repo;
      WorktreesPanel.current.panel.reveal();
      WorktreesPanel.current.send();
      return WorktreesPanel.current;
    }
    await closeStaleWebviewTabs('commitCorner.worktreesOverview');
    const panel = vscode.window.createWebviewPanel('commitCorner.worktreesOverview', 'Worktrees', vscode.ViewColumn.Active, { enableScripts: true });
    WorktreesPanel.current = new WorktreesPanel(ctx, panel, repo);
    return WorktreesPanel.current;
  }

  constructor(ctx, panel, repo) {
    this.ctx = ctx;
    this.panel = panel;
    this.repo = repo;
    panel.iconPath = new vscode.ThemeIcon('list-tree');
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] };
    panel.webview.html = webviewHtml(panel.webview, ctx.extensionUri, { title: 'Worktrees', script: 'worktrees.js', style: 'worktrees.css' });
    const refresh = debounce(() => this.send(), 1500);
    this.disposables = [
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => showError(e, 'Worktrees'))),
      onDidChangeWorktrees(() => this.send()),
      ctx.manager.onDidClose((r) => {
        if (r === this.repo) panel.dispose();
      }),
      ctx.manager.onDidChangeState((r) => {
        if (r === this.repo && panel.visible) refresh();
      }),
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible) refresh();
      }),
    ];
    // Other worktrees (an agent's) change without events here: look again every 10 s while shown.
    const timer = setInterval(() => {
      if (panel.visible) this.send();
    }, 10000);
    this.disposables.push({ dispose: () => clearInterval(timer) });
  }

  async send() {
    // One look at a time (git status in every worktree can take a while); a request meanwhile
    // runs once more afterwards, so the newest state always wins.
    if (this.sending) {
      this.sendAgain = true;
      return;
    }
    this.sending = true;
    try {
      await this.sendNow();
    } finally {
      this.sending = false;
      if (this.sendAgain) {
        this.sendAgain = false;
        this.send();
      }
    }
  }

  async sendNow() {
    try {
      // "This window" is the worktree open in this window, whichever repository is active.
      const worktrees = (await this.repo.getWorktreeDetails()).map((w) => ({ ...w, isCurrent: inThisWindow(w.path) }));
      this.panel.webview.postMessage({
        type: 'data',
        repoName: this.repo.name,
        repoRoot: this.repo.root,
        me: (await this.repo.getConfig('user.email')) || '',
        worktrees: worktrees.map((w) => ({
          ...w,
          commit: w.commit && { sha: w.commit.sha, subject: w.commit.subject, authorName: w.commit.authorName, authorEmail: w.commit.authorEmail, authorDate: w.commit.authorDate },
        })),
      });
    } catch (e) {
      log().error(`Worktrees overview: ${e.stack || e.message}`);
      this.panel.webview.postMessage({ type: 'error', message: e.message });
    }
  }

  async onMessage(m) {
    if (!validMessageShas(m)) return;
    const node = { repoRoot: this.repo.root, worktreePath: m.path };
    if (m.type === 'ready' || m.type === 'refresh') await this.send();
    else if (m.type === 'add') await vscode.commands.executeCommand('commitCorner.worktreeAdd', { repoRoot: this.repo.root });
    else if (m.type === 'prune') await vscode.commands.executeCommand('commitCorner.worktreePrune', { repoRoot: this.repo.root });
    else if (m.type === 'graph' && m.sha) await vscode.commands.executeCommand('commitCorner.showGraph', { repoRoot: this.repo.root, revealSha: m.sha });
    else if (m.type === 'action' && Object.hasOwn(ACTIONS, m.action) && typeof m.path === 'string') {
      // Only paths of this repository's worktrees are acted on.
      const known = (await this.repo.getWorktrees()).some((w) => w.path === m.path);
      if (known) await vscode.commands.executeCommand(ACTIONS[m.action], node);
    }
  }

  dispose() {
    if (WorktreesPanel.current === this) WorktreesPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
  }
}

/** @param {import('../context').Context} ctx */
function register(ctx) {
  ctx.command('commitCorner.showWorktrees', async (arg) => {
    const repo = await ctx.manager.pick(arg);
    if (repo) await WorktreesPanel.show(ctx, repo);
  });
  // Restore an open overview after a window reload.
  return vscode.window.registerWebviewPanelSerializer('commitCorner.worktreesOverview', {
    async deserializeWebviewPanel(panel, state) {
      await ctx.manager.ready;
      const repo = (state && state.repoRoot && ctx.manager.getRepository(state.repoRoot)) || ctx.manager.active || ctx.manager.repositories[0];
      if (!repo) {
        panel.dispose();
        return;
      }
      WorktreesPanel.current = new WorktreesPanel(ctx, panel, repo);
    },
  });
}

module.exports = { WorktreesPanel, register };
