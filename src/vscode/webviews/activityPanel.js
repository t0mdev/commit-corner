'use strict';

const vscode = require('vscode');
const { webviewHtml } = require('./html');
const { showError, log, debounce, shortSha, validMessageShas, escapeIcons, closeStaleWebviewTabs } = require('../util');
const { githubWebUrl, githubPullUrl } = require('../../git/remoteUrl');
const { LOG_FORMAT, parseLog } = require('../../git/parse');

const VIEW_TYPE = 'commitCorner.activity';
const PERIODS = [7, 30, 365];

/**
 * Repository Activity: what happened in the last week, month or year — commits
 * over time, people, busiest files, merged pull requests, active branches and
 * new tags. Everything links back into the graph, history and diffs.
 */
class ActivityPanel {
  /** @param {import('../context').Context} ctx */
  static async show(ctx, repo, state = {}) {
    if (ActivityPanel.current) {
      ActivityPanel.current.repo = repo;
      ActivityPanel.current.panel.reveal();
      ActivityPanel.current.send();
      ActivityPanel.current.panel.webview.postMessage({ type: 'focus' });
      return ActivityPanel.current;
    }
    await closeStaleWebviewTabs(VIEW_TYPE);
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Repository Activity', vscode.ViewColumn.Active, { enableScripts: true });
    ActivityPanel.current = new ActivityPanel(ctx, panel, repo, state);
    return ActivityPanel.current;
  }

  constructor(ctx, panel, repo, state = {}) {
    this.ctx = ctx;
    this.panel = panel;
    this.repo = repo;
    this.days = PERIODS.includes(state.days) ? state.days : 30;
    /** 'all', 'current', or 'ref:<branch>' */
    this.scope = typeof state.scope === 'string' && /^(all|current|ref:[^\0]+)$/.test(state.scope) && !state.scope.startsWith('ref:-') ? state.scope : 'all';
    panel.iconPath = new vscode.ThemeIcon('pulse');
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] };
    panel.webview.html = webviewHtml(panel.webview, ctx.extensionUri, { title: 'Repository Activity', script: 'activity.js', style: 'activity.css' });
    // Keeps up with new commits while shown (refs move), not with every file save.
    const refresh = debounce(() => this.send(), 1500);
    let lastTips;
    this.disposables = [
      ctx.manager.onDidChangeState(async (r) => {
        if (r !== this.repo || !panel.visible) return;
        const tips = r.refTips !== undefined ? r.refTips : await r.getRefTips().catch(() => '');
        if (tips !== lastTips) {
          lastTips = tips;
          refresh();
        }
      }),
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible) refresh();
      }),
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => showError(e, 'Repository Activity'))),
      ctx.manager.onDidClose((r) => {
        if (r === this.repo) panel.dispose();
      }),
    ];
  }

  async send() {
    const token = (this.token = (this.token || 0) + 1);
    this.panel.webview.postMessage({ type: 'loading' });
    try {
      const revs = this.scope === 'current' ? ['HEAD'] : this.scope.startsWith('ref:') ? [this.scope.slice(4)] : undefined;
      const data = await this.repo.activity({ days: this.days, revs });
      if (token !== this.token) return;
      const remotes = await this.repo.getRemotes();
      const web = remotes.map((r) => githubWebUrl(r.fetchUrl)).find(Boolean);
      this.panel.webview.postMessage({
        type: 'data',
        repoName: this.repo.name,
        repoRoot: this.repo.root,
        branch: this.repo.state && this.repo.state.head.branch,
        me: ((await this.repo.getConfig('user.email')) || '').toLowerCase(),
        days: this.days,
        scope: this.scope,
        hasGitHub: !!web,
        ...data,
      });
    } catch (e) {
      log().error(`Repository activity: ${e.stack || e.message}`);
      this.panel.webview.postMessage({ type: 'error', message: e.message });
    }
  }

  async onMessage(m) {
    if (!validMessageShas(m)) return;
    const repoRoot = this.repo.root;
    switch (m.type) {
      case 'ready':
      case 'refresh':
        await this.send();
        break;
      case 'period':
        if (PERIODS.includes(m.days)) this.days = m.days;
        if (m.scope === 'all' || m.scope === 'current' || (typeof m.scope === 'string' && m.scope.startsWith('ref:') && m.scope === this.scope)) this.scope = m.scope;
        else if (m.scope === 'pick') {
          // Any branch: picked here, so the page never names a revision itself.
          const refs = (await this.repo.getRefs()).filter((r) => r.type === 'branch' || r.type === 'remote');
          const pick = await vscode.window.showQuickPick(refs.map((r) => ({ label: `$(${r.type === 'remote' ? 'cloud' : 'git-branch'}) ${escapeIcons(r.name)}`, ref: r.rev || r.name })), { title: 'Repository Activity of one branch', placeHolder: 'Branch' });
          if (pick) this.scope = `ref:${pick.ref}`;
        }
        await this.send();
        break;
      case 'commits': {
        // A chart bar (a day or week) was opened: its commits to choose from.
        const shas = Array.isArray(m.shas) ? m.shas.filter((s) => typeof s === 'string' && /^[0-9a-f]{40,64}$/.test(s)).slice(0, 500) : [];
        if (!shas.length) break;
        const { stdout } = await this.repo.exec(['log', '--no-walk=unsorted', `--format=${LOG_FORMAT}`, ...shas, '--'], { allowFailure: true });
        const wanted = new Set(shas);
        const items = parseLog(stdout).filter((c) => wanted.has(c.sha)).map((c) => ({ label: escapeIcons(c.subject), description: `${escapeIcons(c.authorName)} · ${shortSha(c.sha)}`, sha: c.sha }));
        const pick = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { title: typeof m.label === 'string' ? escapeIcons(m.label.slice(0, 120)) : 'Commits', placeHolder: 'Show the changes of…' });
        if (pick) await vscode.commands.executeCommand('commitCorner.showCommit', { repoRoot, sha: pick.sha });
        break;
      }
      case 'openCommit':
        await vscode.commands.executeCommand('commitCorner.showCommit', { repoRoot, sha: m.sha });
        break;
      case 'author':
        await vscode.commands.executeCommand('commitCorner.showGraph', { repoRoot, search: { mode: 'author', text: m.email || m.name } });
        break;
      case 'file':
        // A repository-relative path, nothing above the repository.
        if (!require('./graphPanel').pagePath(m.path)) break; // also "..\\" and drive letters (Windows)
        await vscode.commands.executeCommand('commitCorner.fileHistory', vscode.Uri.file(this.repo.absolute(m.path)));
        break;
      case 'branch':
        await vscode.commands.executeCommand('commitCorner.showGraph', { repoRoot, filter: { kind: 'ref', ref: m.rev } });
        break;
      case 'pull': {
        const remotes = await this.repo.getRemotes();
        const web = (remotes.find((r) => r.name === 'upstream' && githubWebUrl(r.fetchUrl)) || remotes.find((r) => githubWebUrl(r.fetchUrl)) || {}).fetchUrl;
        if (web && Number.isInteger(m.number)) await vscode.env.openExternal(vscode.Uri.parse(githubPullUrl(githubWebUrl(web), m.number)));
        break;
      }
      default:
        break;
    }
  }

  dispose() {
    if (ActivityPanel.current === this) ActivityPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
  }
}

/** @param {import('../context').Context} ctx */
function register(ctx) {
  ctx.command('commitCorner.showActivity', async (arg) => {
    const repo = await ctx.manager.pick(arg);
    if (repo) await ActivityPanel.show(ctx, repo);
  });
  // Restore an open Activity tab after a reload (its period and scope come back with it).
  return vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
    async deserializeWebviewPanel(panel, state) {
      await ctx.manager.ready;
      const repo = (state && state.repoRoot && ctx.manager.getRepository(state.repoRoot)) || ctx.manager.active || ctx.manager.repositories[0];
      if (!repo) {
        panel.dispose();
        return;
      }
      ActivityPanel.current = new ActivityPanel(ctx, panel, repo, state || {});
    },
  });
}

module.exports = { ActivityPanel, register };
