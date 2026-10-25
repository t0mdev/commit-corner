'use strict';

const vscode = require('vscode');
const notify = require('../notify');
const { GraphLayout } = require('../../git/graph');
const { EMPTY_TREE, checkRevs } = require('../../git/repository');
const { webviewHtml } = require('./html');
const { config, debounce, showError, shortSha, log, validMessageShas, escapeIcons, isSha, closeStaleWebviewTabs } = require('../util');
const { openDiff, openMultiDiff } = require('../diffs');
const { showCommit, showCommits, showRange } = require('../commands/historyCommands');

const VIEW_TYPE = 'commitCorner.graph';
/** Commands the details pane may ask for; anything else from the webview is ignored. */
const WEBVIEW_COMMANDS = new Set([
  'commitCorner.fetch', 'commitCorner.checkoutDetached', 'commitCorner.createBranch', 'commitCorner.cherryPick',
  'commitCorner.revert', 'commitCorner.stash', 'workbench.view.scm', 'commitCorner.push', 'commitCorner.pull',
  'commitCorner.checkout', 'commitCorner.copySha', 'commitCorner.openCommitOnGitHub', 'commitCorner.showWorktrees',
  'commitCorner.openPullRequestOnGitHub',
]);
/** Rows the graph loads at most to reveal an old commit (each row is laid out and sent). */
const REVEAL_LIMIT = 20000;
const WORKTREE_SHA = '*';

/** A repository-relative path from a page: nothing absolute, above the repository or with control characters (both separators). */
const pagePath = (p) => typeof p === 'string' && !!p && p.length < 4096 && !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes('..') && !/[\u0000-\u001f]/.test(p);

/** A revision or full ref name git cannot read as an option (no leading "-", no spaces or control bytes). */
const plainRev = (r) => typeof r === 'string' && !!r && !r.startsWith('-') && !/[\s\u0000-\u001f\u007f]/.test(r);

/** Arguments a webview page may pass to a command: a commit SHA or PR number, nothing else. */
function pageArgs(args, repoRoot) {
  const out = { repoRoot };
  if (args && typeof args === 'object') {
    if (typeof args.sha === 'string' && /^[0-9a-f]{7,64}$/.test(args.sha)) out.sha = args.sha;
    if (Number.isSafeInteger(args.number) && args.number > 0) out.number = args.number;
  }
  return out;
}

/**
 * The commit graph: a webview with a virtualized, lane-rendered history,
 * multi-selection, search, branch filtering and a details pane. Actions use
 * VS Code's native webview context menus (contributes.menus.webview/context),
 * so right-click menus look and behave like the rest of the editor.
 *
 * One class drives both places the graph appears: the editor tab
 * (a WebviewPanel) and the compact Graph view in the sidebar (a WebviewView,
 * wrapped by sidebarSurface() into the same shape). The sidebar follows the
 * active repository and has no details pane.
 */
class GraphPanel {
  /**
   * @param {import('../context').Context} ctx
   * @param {{compact?: boolean}} [opts] compact: the sidebar view
   */
  constructor(ctx, panel, repo, state = {}, opts = {}) {
    this.ctx = ctx;
    this.panel = panel;
    this.repo = repo;
    this.compact = !!opts.compact;
    /** Sent with every context menu, so menu commands find the right graph. */
    this.surface = this.compact ? 'sidebar' : 'panel';
    this.limit = config().get('graph.pageSize', 1000);
    this.filter = { kind: 'all' };
    // Restored page state is the page's word: it goes through the same checks as a message.
    if (state.filter) this.applyView({ filter: state.filter });
    this.search = undefined; // {mode, text} when showing server-side search results
    this.selection = [];
    this.includeRefs = [];
    this.loadToken = 0;
    this.lastSignature = '';
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'graph.svg');
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] };
    panel.webview.html = webviewHtml(panel.webview, ctx.extensionUri, { title: 'Commit Graph', script: 'graph.js', style: 'graph.css' });
    this.updateTitle();
    const reloadIfChanged = debounce(() => this.reloadIfChanged(), 400);
    // Staging happens in the graph too: an open uncommitted-changes list follows the state.
    // The status the repository just read (no second `git status` for the same change).
    const refreshWorktreeFiles = debounce(() => this.sendFiles(WORKTREE_SHA, { fresh: false }).catch(() => {}), 300);
    this.disposables = [
      panel.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => showError(e, 'Graph'))),
      panel.onDidDispose(() => this.dispose()),
      ctx.manager.onDidChangeState((r) => {
        if (r !== this.repo) return;
        reloadIfChanged();
        if (this.wtOpen && this.panel.visible) refreshWorktreeFiles();
      }),
      ctx.manager.onDidClose((r) => {
        if (r !== this.repo) return;
        if (this.compact) this.setRepo(ctx.manager.active || ctx.manager.repositories[0]);
        else panel.dispose();
      }),
      // The sidebar shows the active repository.
      ctx.manager.onDidChangeActive((r) => {
        if (this.compact && r && r !== this.repo) this.setRepo(r);
      }),
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible && this.stale) {
          this.stale = false;
          this.reloadIfChanged();
        }
        if (this.compact && !e.webviewPanel.visible) this.markLookedAway();
      }),
      vscode.window.onDidChangeWindowState((s) => {
        if (this.compact && !s.focused && this.panel.visible) this.markLookedAway();
      }),
    ];
    // Other worktrees (an agent's) change without any event here: while the graph is shown,
    // look at their uncommitted work every 10 seconds (as the Worktrees view does).
    const wipTimer = setInterval(() => {
      if (this.panel.visible && this.layout && !this.wipBusy) {
        this.wipBusy = true;
        this.sendWorktreeWip(this.loadToken).catch(() => {}).finally(() => (this.wipBusy = false));
      }
    }, 10000);
    this.disposables.push({ dispose: () => clearInterval(wipTimer) });
  }

  /** Switch to another repository (sidebar), starting from a clean filter and selection. */
  setRepo(repo) {
    if (!repo) return;
    this.repo = repo;
    this.wtOpen = false; // the page asks for the uncommitted files again if it shows them
    if (this.genCts) this.genCts.cancel(); // a message being written was for the other repository
    this.selection = [];
    this.search = undefined;
    this.filter = { kind: 'all' };
    this.includeRefs = [];
    this.limit = config().get('graph.pageSize', 1000);
    this.updateTitle();
    if (this.panel.visible) this.load();
    else this.stale = true;
  }

  /** Optional starting point from other views: a branch filter or an author/message search. */
  /** @returns {boolean} whether anything valid was applied */
  applyView(opts) {
    let applied = false;
    const kinds = ['all', 'local', 'current', 'firstParent', 'ref'];
    const f = opts.filter;
    // A ref must be a plain revision: never something git could read as an option.
    if (f && kinds.includes(f.kind) && (f.kind !== 'ref' || (typeof f.ref === 'string' && f.ref && !f.ref.startsWith('-')))) {
      this.filter = f.kind === 'ref' ? { kind: 'ref', ref: f.ref } : { kind: f.kind };
      this.includeRefs = [];
      applied = true;
    }
    const s = opts.search;
    if (s && ['message', 'author', 'content', 'file', 'sha'].includes(s.mode) && typeof s.text === 'string' && s.text.length <= 1000) {
      this.search = { mode: s.mode, text: s.text };
      applied = true;
    }
    return applied;
  }

  /** The graph a webview context-menu command came from (its data carries `surface`). */
  static forContext(arg) {
    if (arg && arg.surface === 'sidebar' && GraphPanel.sidebar) return GraphPanel.sidebar;
    if (arg && arg.surface === 'panel' && GraphPanel.current) return GraphPanel.current;
    return GraphPanel.current || GraphPanel.sidebar;
  }

  static async show(ctx, repo, opts = {}) {
    let instance = GraphPanel.current;
    if (instance) {
      if (instance.repo !== repo) {
        instance.repo = repo;
        instance.selection = [];
        instance.search = undefined;
        // A branch filter from another repository would be an unknown revision here.
        instance.filter = { kind: 'all' };
        instance.includeRefs = [];
        instance.limit = config().get('graph.pageSize', 1000);
        instance.updateTitle();
      }
      if (Array.isArray(opts.includeRefs)) instance.includeRefs = opts.includeRefs.filter(plainRev);
      instance.applyView(opts);
      instance.panel.reveal(undefined, false);
      instance.post({ type: 'focusList' });
      await instance.load({ reveal: opts.revealSha });
      return instance;
    }
    // Not retained while hidden (VS Code guidance): the webview saves its scroll and
    // selection with setState, the host keeps filter and selection, and it reloads when shown.
    await closeStaleWebviewTabs(VIEW_TYPE);
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Commit Graph', { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, { enableFindWidget: false });
    instance = new GraphPanel(ctx, panel, repo);
    if (Array.isArray(opts.includeRefs)) instance.includeRefs = opts.includeRefs.filter(plainRev);
    instance.applyView(opts);
    instance.pendingReveal = opts.revealSha;
    GraphPanel.current = instance;
    return instance;
  }

  updateTitle() {
    const several = this.ctx.manager.repositories.length > 1;
    if (this.compact) {
      // The view's description says what is shown, so a branch filter is never invisible.
      const f = this.filter;
      const what = f.kind === 'ref' ? f.ref : { local: 'local branches', current: 'current branch', firstParent: 'current branch, first parent' }[f.kind];
      this.panel.description = [several && this.repo ? this.repo.name : '', what || ''].filter(Boolean).join(' · ') || undefined;
      vscode.commands.executeCommand('setContext', 'commitCorner.graphViewFiltered', f.kind !== 'all');
    } else this.panel.title = several ? `Commit Graph: ${this.repo.name}` : 'Commit Graph';
  }

  // ---- "new since you last looked" --------------------------------------------

  /** Storage key of what was seen, per repository. */
  seenKey() {
    return `commitCorner.seen.${this.repo.root}`;
  }

  /** {time, tips: {revision: sha}}: when you last looked away, and where the branches were then. */
  get seen() {
    const m = this.ctx.manager.memento;
    return (m && m.get(this.seenKey())) || undefined;
  }

  /**
   * You looked away (the view was hidden or the window lost focus): everything committed from
   * now on is "new" the next time you look, and the current tips are what changes are measured from.
   */
  /** Every local and remote branch tip (plus HEAD), by name. */
  async branchTips() {
    const tips = {};
    const { stdout } = await this.repo.exec(['for-each-ref', '--format=%(refname)%1f%(objectname)', 'refs/heads', 'refs/remotes'], { allowFailure: true });
    for (const line of stdout.split('\n')) {
      const [ref, sha] = line.split('\x1f');
      if (ref && sha && !ref.endsWith('/HEAD')) tips[ref.replace(/^refs\/(heads|remotes)\//, '')] = sha;
    }
    const head = await this.repo.revParse('HEAD').catch(() => undefined);
    if (head) tips.HEAD = head;
    return tips;
  }

  async markLookedAway() {
    const m = this.ctx.manager.memento;
    if (!m || !this.repo) return;
    await m.update(this.seenKey(), { time: Date.now(), tips: await this.branchTips() });
  }

  /**
   * What moved since you last looked away: the shown branch, or — with all branches shown —
   * every branch that moved (one: straight to its changes; several: pick one). A branch's
   * changes are a multi-diff from where it was then to where it is now.
   */
  async showChangesSinceSeen() {
    const seen = this.seen;
    if (!seen || !seen.tips) {
      notify.info('Nothing recorded yet: changes are measured from the last time you looked away from the graph (hid it or left the window).');
      return;
    }
    const now = await this.branchTips();
    const filtered = this.filter.kind === 'ref' ? this.filter.ref : this.filter.kind === 'all' ? undefined : 'HEAD';
    const names = filtered ? [filtered] : Object.keys(now).filter((n) => n !== 'HEAD');
    const moved = [];
    for (const name of names) {
      const before = seen.tips[name];
      const after = now[name] || (await this.repo.revParse(name).catch(() => undefined));
      if (!after || before === after) continue;
      let label = 'new branch';
      if (before) {
        const forward = await this.repo.isAncestor(before, after).catch(() => false);
        const { stdout } = await this.repo.exec(['rev-list', '--count', `${before}..${after}`], { allowFailure: true });
        const n = Number(stdout.trim()) || 0;
        label = `${n} new commit${n === 1 ? '' : 's'}${forward ? '' : ' (rewritten / force-pushed)'}`;
      }
      moved.push({ name, before, after, label });
    }
    if (!moved.length) {
      notify.info(`${filtered ? `${filtered} has` : 'No branch has'} not moved since you last looked (${new Date(seen.time).toLocaleString()}).`);
      return;
    }
    let pick = moved[0];
    if (moved.length > 1) {
      const choice = await vscode.window.showQuickPick(moved.map((x) => ({ label: `$(git-branch) ${escapeIcons(x.name)}`, description: x.label, x })), { title: `Moved since you last looked (${new Date(seen.time).toLocaleString()})`, placeHolder: 'Show the changes of…' });
      if (!choice) return;
      pick = choice.x;
    }
    const rev = pick.name;
    const before = pick.before || (await this.repo.mergeBase(pick.after, 'HEAD'));
    const now2 = pick.after;
    if (!before) {
      notify.info(`${rev} is new and shares no history with HEAD.`);
      return;
    }
    // Tree to tree, so it also works after a force-push or rebase.
    const files = await this.repo.diffFiles(before, now2);
    await openMultiDiff(this.repo, `${rev}: changes since you last looked (${shortSha(before)} ↔ ${shortSha(now2)})`, files.map((f) => ({
      path: f.path,
      leftRef: f.status === 'A' ? null : before,
      leftPath: f.origPath || f.path,
      rightRef: f.status === 'D' ? null : now2,
      rightPath: f.path,
    })));
  }

  post(message) {
    return this.panel.webview.postMessage(message);
  }

  revs() {
    const f = this.filter;
    const extra = (this.includeRefs || []).filter(plainRev);
    if (f.kind === 'ref') checkRevs(f.ref); // never an option, whatever set it
    if (f.kind === 'current') return ['HEAD', ...extra];
    if (f.kind === 'ref') return [f.ref, ...extra];
    if (f.kind === 'local') return ['--branches', 'HEAD', ...extra];
    if (f.kind === 'firstParent') return ['HEAD', ...extra];
    return ['--branches', '--remotes', '--tags', 'HEAD', ...extra];
  }

  /** What forces a full reload: HEAD, refs, and whether there are uncommitted changes at all. */
  async signature() {
    if (!this.repo) return '';
    const tips = this.repo.refTips !== undefined ? this.repo.refTips : await this.repo.getRefTips();
    const s = this.repo.state;
    return `${s && s.head.sha}|${s && s.head.branch}|${!!worktreeSubject(s)}|${tips}`;
  }

  /**
   * Before loading, make sure a commit we want to reveal is part of what gets
   * loaded: raise the page limit to reach it (commits that are not its
   * ancestors come before it in topological order), or add it to the shown
   * refs when the current filter does not reach it at all.
   */
  async makeRevealable(sha) {
    checkRevs(sha);
    const reachable = await this.repo.exec(['merge-base', '--is-ancestor', sha, 'HEAD'], { allowFailure: true });
    let inRevs = reachable.exitCode === 0;
    if (!inRevs) {
      const { stdout } = await this.repo.exec(['for-each-ref', '--contains', sha, '--count=1', '--format=%(refname)', ...(this.filter.kind === 'all' ? ['refs/heads', 'refs/remotes', 'refs/tags'] : ['refs/heads'])], { allowFailure: true });
      inRevs = !!stdout.trim() && this.filter.kind !== 'current' && this.filter.kind !== 'ref';
    }
    const { stdout } = await this.repo.exec(['rev-list', '--count', ...this.revs(), ...(inRevs ? [] : [sha]), `^${sha}`], { allowFailure: true });
    const before = Number(stdout.trim()) || 0;
    const pageSize = config().get('graph.pageSize', 1000);
    // Far back: the graph does not load 100,000 rows to show one; that commit opens on its own.
    if (before >= REVEAL_LIMIT) {
      notify.info(`That commit is ${before.toLocaleString('en-US')} commits back — more than the graph loads at once. Showing it on its own.`);
      vscode.commands.executeCommand('commitCorner.showCommit', { repoRoot: this.repo.root, sha });
      return false;
    }
    // Only now the graph takes the commit's history in (not when it shows the commit on its own).
    if (!inRevs) this.includeRefs = [...new Set([...(this.includeRefs || []), sha])];
    if (before + 1 > this.limit) this.limit = Math.min(before + pageSize, REVEAL_LIMIT);
    return true;
  }

  async reloadIfChanged() {
    if (this.disposed || !this.repo) return;
    if (!this.panel.visible) {
      // Hidden panels catch up when they are shown again.
      this.stale = true;
      return;
    }
    const sig = await this.signature().catch(() => '');
    if (sig !== this.lastSignature) await this.load({ keepScroll: true });
    else {
      // Only the number of changed files moved: update that row's text, no history reload.
      const subject = worktreeSubject(this.repo.state);
      if (subject) this.post({ type: 'worktree', subject, wt: worktreeCounts(this.repo.state) });
    }
  }

  /** Load commits, lay out the graph and send everything to the webview. */
  async load(opts = {}) {
    if (this.disposed) return;
    if (!this.repo) {
      // The sidebar in a folder without a repository: what can be done here (again after every
      // page load), in the sidebar's own layout.
      this.post({ type: 'noRepository', settings: { compact: this.compact, surface: this.surface } });
      return;
    }
    this.updateTitle();
    const token = ++this.loadToken;
    // A newer load (search, filter, refresh) cancels the git process of the previous one.
    if (this.loadController) this.loadController.abort();
    const controller = new AbortController();
    this.loadController = controller;
    this.post({ type: 'loading' });
    try {
      this.lastSignature = await this.signature();
      const repo = this.repo;
      let commits;
      let filtered = false;
      if (this.search) {
        const s = this.search;
        const o = { maxCount: this.limit, revs: this.revs(), topo: true, signal: controller.signal };
        if (s.mode === 'message') o.grep = s.text;
        else if (s.mode === 'author') o.author = s.text;
        else if (s.mode === 'content') o.pickaxe = s.text;
        // Literal path unless the user typed a wildcard.
        else if (s.mode === 'file') o.paths = [/[*?]/.test(s.text) ? s.text : `:(literal)${s.text}`];
        else if (s.mode === 'sha') {
          // Jump to any commit or ref in the whole history, loaded or not.
          const sha = await repo.revParse(s.text.trim());
          this.search = undefined;
          if (!sha) {
            this.post({ type: 'error', message: `"${s.text}" is not a commit or ref in this repository.` });
            return;
          }
          await this.load({ reveal: sha });
          return;
        }
        commits = await repo.log(o);
        filtered = s.mode !== 'file';
      } else {
        const reveal = opts.reveal || this.pendingReveal;
        if (reveal && !this.search && !(await this.makeRevealable(reveal))) {
          // Too far back: shown on its own instead; the graph stays where it is.
          opts = { ...opts, reveal: undefined };
          this.pendingReveal = undefined;
        }
        commits = await repo.log({ ...this.logOptions(), maxCount: this.limit, signal: controller.signal });
      }
      if (token !== this.loadToken) return;

      const state = repo.state;
      const rows = [];
      const layout = new GraphLayout();
      this.layout = layout;
      layout.shown = new Set(commits.map((c) => c.sha));
      this.loaded = commits.length;
      this.filtered = filtered;
      const shas = new Set(commits.map((c) => c.sha));
      const dirty = state && !this.search && state.staged.length + state.unstaged.length + state.untracked.length + state.conflicts.length;
      // Also clean while the staging area is open (just committed): Amend and Undo stay at hand.
      if ((dirty || (this.wtOpen && state && !this.search)) && state.head.sha) {
        const wt = { sha: WORKTREE_SHA, parents: [state.head.sha] };
        rows.push(row(wt, layout.addOne(wt), {
          subject: worktreeSubject(state) || 'No uncommitted changes',
          wt: worktreeCounts(state),
          authorName: '', authorDate: Date.now(), refs: [], parents: [state.head.sha],
        }));
      }
      for (const c of commits) {
        // In filtered results, only connect commits that are both in the result.
        const parents = filtered ? c.parents.filter((p) => shas.has(p)) : c.parents;
        rows.push(row(c, layout.addOne({ sha: c.sha, parents }), c));
      }
      this.post({
        type: 'data',
        repoName: repo.name,
        repoRoot: repo.root,
        head: state && state.head,
        rows,
        maxWidth: layout.maxWidth,
        hasMore: commits.length >= this.limit,
        filter: this.filter,
        search: this.search,
        branches: await repo.getBranchNames(),
        me: await this.userEmail(),
        // GitHub links only where there is a github.com remote.
        onGitHub: (await repo.getRemotes().catch(() => [])).some((r) => require('../../git/remoteUrl').githubWebUrl(r.fetchUrl)),
        // Rows committed after this are marked new (sidebar): you were away when they arrived.
        newSince: this.compact && this.seen ? this.seen.time : undefined,
        keepScroll: !!opts.keepScroll,
        reveal: opts.reveal || this.pendingReveal,
        selection: this.selection,
        settings: { compact: this.compact, surface: this.surface, dateOrder: !this.compact && config().get('graph.order', 'topological') === 'date', showAuthor: config().get('graph.showAuthor', true), showDate: config().get('graph.showDate', true), showSha: config().get('graph.showSha', true), showChanges: config().get('graph.showChanges', true), dateFormat: config().get('dateFormat', 'relative') },
      });
      this.pendingReveal = undefined;
      // The sidebar's 7-day summary follows the rows, so it never delays the graph.
      if (this.compact) {
        repo.activitySummary(7).then((activity) => {
          if (token === this.loadToken) this.post({ type: 'activitySummary', activity });
        }, (e) => log().warn(`Activity summary: ${e.message}`));
      }
      // Uncommitted work in the other worktrees (an agent's), shown on their branch tips.
      this.sendWorktreeWip(token).catch((e) => log().warn(`Worktree changes: ${e.message}`));
    } catch (e) {
      if (e && e.code === 'Cancelled') return;
      if (token === this.loadToken) this.post({ type: 'error', message: e.message });
      log().error(`Graph load failed: ${e.stack || e.message}`);
    }
  }

  async onMessage(m) {
    if (!validMessageShas(m, [WORKTREE_SHA])) return;
    const repo = this.repo;
    switch (m.type) {
      case 'draftChanged': {
        // The graph's commit message is Source Control's too (one draft per repository).
        const provider = repo && m.repoRoot === repo.root && typeof m.text === 'string' && this.ctx.scm && this.ctx.scm.get(repo);
        if (provider) this.shareDraft(repo, provider, m.text);
        break;
      }
      case 'draftPull': {
        // A graph's box got the keyboard (or was drawn again with a kept draft): whichever is
        // newer wins. Source Control's text when it was edited there since a graph last set it;
        // otherwise this box's text goes on to Source Control (and the other graph).
        const provider = repo && m.repoRoot === repo.root && this.ctx && this.ctx.scm && this.ctx.scm.get(repo);
        if (!provider) break;
        const scmText = provider.message;
        const sent = GraphPanel.draftSent.get(repo.root);
        const editedThere = scmText !== (sent === undefined ? '' : sent) && !!scmText.trim() && scmText !== provider.template;
        if (editedThere) this.post({ type: 'draftSet', repoRoot: repo.root, text: scmText });
        else if (typeof m.text === 'string' && m.text.trim() && m.text !== scmText) this.shareDraft(repo, provider, m.text);
        break;
      }
      case 'noRepoAction':
        // The three buttons of the "no repository" page: these commands and no others.
        if (['commitCorner.init', 'commitCorner.clone', 'commitCorner.openRepository'].includes(m.id)) await vscode.commands.executeCommand(m.id);
        break;
      case 'ready':
        // A new page (re-created webview): it asks again for what it shows.
        this.wtOpen = false;
        this.lastWip = undefined;
        await this.load();
        // Ctrl+Alt+G V before the view existed: the page is here now, focus its list.
        if (this.compact && GraphPanel.focusSidebarPending) {
          GraphPanel.focusSidebarPending = false;
          this.focusList();
        }
        break;
      case 'refresh':
        await this.load({ keepScroll: true });
        break;
      case 'loadMore':
        await this.loadMore();
        break;
      // Messages from the page are validated like any other input before they reach git.
      case 'filter':
        if (!this.applyView({ filter: m.filter })) break;
        await this.load();
        break;
      case 'search':
        if (!m.text) this.search = undefined;
        else if (!this.applyView({ search: { mode: m.mode, text: m.text } })) break;
        await this.load();
        break;
      case 'select':
        if (!Array.isArray(m.shas)) break;
        this.selection = m.shas.filter((s) => typeof s === 'string' && s !== WORKTREE_SHA && /^[0-9a-f]{40,64}$/.test(s));
        // The sidebar has no details pane (Enter shows the commit).
        if (!this.compact) await this.sendDetails(m.shas, m.requestId);
        break;
      case 'openFile':
        await this.openFile(m);
        break;
      case 'openCommit':
        if (m.sha === WORKTREE_SHA) await vscode.commands.executeCommand('workbench.view.scm');
        else {
          await showCommit(repo, m.sha);
          // Space in the sidebar: a preview, so the list keeps the keyboard.
          if (m.preview && this.compact) {
            await vscode.commands.executeCommand('commitCorner.graphView.focus');
            this.post({ type: 'focusList' });
          }
        }
        break;
      case 'openCommits':
        await showCommits(repo, m.shas);
        break;
      case 'openRange':
        await showRange(repo, m.shas);
        break;
      case 'command':
        // Buttons in the details pane reuse the regular commands (allowlisted).
        if (!WEBVIEW_COMMANDS.has(m.command)) {
          log().warn(`Graph webview asked for unexpected command ${m.command}`);
          break;
        }
        // The page may say which commit (and pull request number), never which repository,
        // remote or anything else: those come from the host.
        await vscode.commands.executeCommand(m.command, pageArgs(m.args, repo.root));
        break;
      case 'actions':
        await this.showActions(m);
        break;
      case 'stats': {
        // Change statistics for the rows on screen (lazily: computing them for all history is slow).
        // Background work: failures are logged, never shown, and the rows may ask again later.
        const shas = (m.shas || []).slice(0, 400);
        try {
          const stats = await repo.commitStats(shas);
          this.post({ type: 'stats', stats: Object.fromEntries([...stats].map(([sha, st]) => [sha, [st.files, st.added, st.deleted]])) });
        } catch (e) {
          log().warn(`Graph stats: ${e.message}`);
          this.post({ type: 'stats', stats: {}, failed: shas });
        }
        break;
      }
      case 'files':
        // The uncommitted changes are open: keep their list current as files change.
        if (m.sha === WORKTREE_SHA) this.wtOpen = true;
        await this.sendFiles(m.sha);
        break;
      case 'activity':
        await vscode.commands.executeCommand('commitCorner.showActivity', { repoRoot: repo.root });
        break;
      case 'wtAction':
        await this.worktreeAction(m);
        break;
      case 'generateMessage':
        await this.generateMessage(m);
        break;
      case 'generateStop':
        if (this.genCts) this.genCts.cancel();
        break;
      case 'filesClosed': {
        if (m.sha !== WORKTREE_SHA || !this.wtOpen) break;
        this.wtOpen = false;
        // Shown only because it was open (the tree is clean): closed, the row goes.
        const st = repo.state;
        if (st && !(st.staged.length + st.unstaged.length + st.untracked.length + st.conflicts.length)) await this.load({ keepScroll: true });
        break;
      }
      case 'worktreeChanges': {
        // The uncommitted changes of the worktree whose HEAD is m.sha (looked up here).
        const p = this.wipPaths && this.wipPaths.get(m.sha);
        if (p) await vscode.commands.executeCommand('commitCorner.worktreeOpenChanges', { repoRoot: repo.root, worktreePath: p });
        break;
      }
      case 'copy':
        // Only commit SHAs (one per line): the page never puts other text (a shell command) on the clipboard.
        if (typeof m.text !== 'string' || !m.text || m.text.split('\n').length > 1000 || !m.text.split('\n').every(isSha)) break;
        await vscode.env.clipboard.writeText(m.text);
        vscode.window.setStatusBarMessage(`Copied ${m.text.length > 12 ? shortSha(m.text) : m.text}`, 2000);
        break;
      default:
        break;
    }
  }

  /** History options of the unsearched graph: shared by the first page and every later page. */
  logOptions() {
    // The sidebar lists by commit date (newest first), so its Today / This week / … ranges match
    // the ages it shows; the editor graph keeps topological order (branches stay together).
    return { revs: this.revs(), topo: !this.compact && config().get('graph.order', 'topological') !== 'date', firstParent: this.filter.kind === 'firstParent' };
  }

  /** Uncommitted work of the other worktrees, by HEAD SHA (the host keeps sha -> path; the page only ever names the SHA). */
  async sendWorktreeWip(token) {
    const repo = this.repo;
    const details = (await repo.getWorktreeDetails()).slice(1).filter((w) => w.head && w.changes && !w.prunable);
    if (token !== this.loadToken) return;
    this.wipPaths = new Map();
    const wip = {};
    for (const w of details) {
      const c = w.changes;
      if (!(c.staged + c.unstaged + c.untracked + c.conflicts)) continue;
      this.wipPaths.set(w.head, w.path);
      wip[w.head] = { name: w.branch || require('path').basename(w.path), staged: c.staged, unstaged: c.unstaged, untracked: c.untracked, conflicts: c.conflicts };
    }
    // Unchanged: no message (the page would draw every row again for nothing).
    const json = JSON.stringify(wip);
    if (json === this.lastWip) return;
    this.lastWip = json;
    this.post({ type: 'worktreeWip', wip });
  }

  /**
   * Staging from the graph's uncommitted changes: the page names an action and a file (or a
   * group); the file must be in that group of the current status. Everything runs through the
   * regular commands, with their confirmations (discard, protected branches, pushed commits…).
   */
  async worktreeAction(m) {
    const repo = this.repo;
    // The page acts on the repository it shows: after a switch it may still show the old one.
    if (!repo || m.repoRoot !== repo.root) return;
    // One at a time: a second Enter on the commit box must not commit again. The page hears
    // back either way (it never waits for an answer that does not come).
    if (this.wtBusy) {
      this.post({ type: 'wtDone', busy: true });
      return;
    }
    this.wtBusy = true;
    try {
      await this.runWorktreeAction(repo, m);
    } finally {
      this.wtBusy = false;
      this.post({ type: 'wtDone' });
    }
  }

  async runWorktreeAction(repo, m) {
    const s = await repo.refreshState();
    const groups = { merge: s.conflicts, staged: s.staged, unstaged: s.unstaged, untracked: s.untracked };
    // One file (`path`), or every file of the group under a folder (`folder`).
    const list = !groups[m.group] ? []
      : typeof m.folder === 'string' && m.folder ? groups[m.group].filter((e) => e.path.startsWith(`${m.folder}/`))
        : typeof m.path === 'string' ? groups[m.group].filter((e) => e.path === m.path) : [];
    const res = list.length ? list.map((entry) => ({ repoRoot: repo.root, path: entry.path, origPath: entry.origPath, group: m.group, status: entry.x || entry.y })) : undefined;
    const run = (cmd, arg) => vscode.commands.executeCommand(cmd, arg);
    const at = { repoRoot: repo.root };
    switch (m.action) {
      case 'stage': if (res && m.group !== 'staged') await run('commitCorner.stage', res); break;
      case 'unstage': if (res && m.group === 'staged') await run('commitCorner.unstage', res); break;
      case 'discard': if (res && (m.group === 'unstaged' || m.group === 'untracked')) await run('commitCorner.discard', res); break;
      case 'stageGroup': if (m.group === 'unstaged' || m.group === 'untracked') await run('commitCorner.stageAll', { ...at, id: m.group }); break;
      case 'unstageAll': await run('commitCorner.unstageAll', at); break;
      case 'discardGroup':
        if (m.group === 'unstaged') await run('commitCorner.discardAll', at);
        else if (m.group === 'untracked') await run('commitCorner.cleanAll', at);
        break;
      case 'commit':
      case 'amend': {
        const message = typeof m.message === 'string' ? m.message.slice(0, 100000) : '';
        const before = s.head.sha;
        await run(m.action === 'amend' ? 'commitCorner.commitAmend' : 'commitCorner.commit', { ...at, message });
        if ((await repo.revParse('HEAD')) !== before) {
          // One draft: Source Control's box (which may hold an older part of this message) and
          // every graph's box are emptied.
          const provider = this.ctx && this.ctx.scm && this.ctx.scm.get(repo);
          if (provider) {
            provider.message = provider.template || '';
            GraphPanel.draftSent.set(repo.root, provider.message);
          }
          this.post({ type: 'wtCommitted' });
          GraphPanel.committedElsewhere(repo, this);
        }
        break;
      }
      case 'undoCommit': await run('commitCorner.undoLastCommit', at); break;
      default: return;
    }
    await repo.refreshState();
    await this.sendFiles(WORKTREE_SHA);
  }

  /** ✨ in the commit box: a language model writes the message; the page shows it as it comes. */
  async generateMessage(m) {
    const repo = this.repo;
    // Every answer names its repository: the page drops what is not for the one it shows.
    if (!repo || m.repoRoot !== repo.root || this.genCts) {
      this.post({ type: 'wtMessage', repoRoot: m.repoRoot, done: true, failed: true });
      return;
    }
    const ai = require('../ai');
    const cts = (this.genCts = new vscode.CancellationTokenSource());
    const post = (x) => {
      if (!cts.token.isCancellationRequested || x.done) this.post({ type: 'wtMessage', repoRoot: repo.root, ...x });
    };
    try {
      const text = await ai.commitMessage(repo, { token: cts.token, onText: (t) => post({ text: t }) });
      post({ text, done: true });
    } catch (e) {
      post({ done: true, failed: true });
      if (e instanceof ai.AiUnavailable) notify.warn(e.message);
      else showError(e, 'Commit message');
    } finally {
      this.genCts = undefined;
      cts.dispose();
    }
  }

  /** A commit from Source Control: the graphs showing this repository empty their message box too. */
  /** A graph's draft into Source Control's box and the other graph's. */
  shareDraft(repo, provider, text) {
    if (provider.message !== text) provider.message = text.slice(0, 100000);
    GraphPanel.draftSent.set(repo.root, provider.message);
    for (const p of [GraphPanel.current, GraphPanel.sidebar]) if (p && p !== this && p.repo === repo) p.post({ type: 'draftSet', repoRoot: repo.root, text: provider.message });
  }

  static committedElsewhere(repo, except) {
    for (const p of [GraphPanel.current, GraphPanel.sidebar]) if (p && p !== except && p.repo === repo) p.post({ type: 'wtCommitted' });
  }

  /** Whether every commit is in HEAD's history. */
  async allOnHead(shas) {
    const valid = shas.filter(isSha);
    if (!valid.length || valid.length !== shas.length) return false;
    // The selected commits not reachable from HEAD, in one walk (on stdin: any number).
    const r = await this.repo.exec(['rev-list', '--stdin', '--no-walk'], { input: `${valid.join('\n')}\n^HEAD\n`, allowFailure: true });
    return r.exitCode === 0 && !r.stdout.trim();
  }

  /** Keyboard focus into the commit list (the sidebar view first takes focus itself). */
  focusList() {
    if (this.panel.focus) this.panel.focus();
    this.post({ type: 'focusList' });
  }

  /** Append the next page of history, continuing the existing lane layout. */
  async loadMore() {
    const pageSize = config().get('graph.pageSize', 1000);
    if (this.search || this.filtered || !this.layout) {
      // Filtered results connect only commits within the result: re-lay out everything.
      this.limit += pageSize;
      await this.load({ keepScroll: true });
      return;
    }
    // Refs moved since the list was loaded (an agent committed, a force push): `--skip` would
    // start the next page in the wrong place. Load everything again, one page more.
    if ((await this.signature()) !== this.lastSignature) {
      this.limit = this.loaded + pageSize;
      await this.load({ keepScroll: true });
      return;
    }
    const token = ++this.loadToken;
    const page = await this.repo.log({ ...this.logOptions(), maxCount: pageSize, skip: this.loaded });
    if (token !== this.loadToken) return;
    // Belt and braces: never add a commit twice (it would get a second lane and row).
    const shown = this.layout.shown || (this.layout.shown = new Set());
    const commits = page.filter((c) => !shown.has(c.sha) && shown.add(c.sha));
    this.loaded += page.length;
    this.limit = this.loaded;
    const rows = commits.map((c) => row(c, this.layout.addOne(c), c));
    this.post({ type: 'append', rows, maxWidth: this.layout.maxWidth, hasMore: page.length >= pageSize });
  }

  /** The changed files under an expanded commit (or the working tree) in the sidebar. */
  /** @param {{fresh?: boolean}} [o] fresh: false — the uncommitted files from the status just read */
  async sendFiles(sha, o = {}) {
    const repo = this.repo;
    // Tagged with the repository: the page drops a late answer about the one it showed before.
    const post = (m) => {
      if (this.repo === repo) this.post({ type: 'files', sha, repoRoot: repo.root, ...m });
    };
    try {
      if (sha === WORKTREE_SHA) {
        const s = o.fresh === false && repo.state ? repo.state : await repo.refreshState();
        // Lines added and deleted per file, like a commit's files (staged: index vs HEAD;
        // changes: working tree vs index); skipped for very large change sets.
        const [stagedStats, unstagedStats] = s.staged.length + s.unstaged.length > 2000 ? [new Map(), new Map()] : await Promise.all([
          repo.numstat(['--cached']).catch(() => new Map()),
          repo.numstat([]).catch(() => new Map()),
        ]);
        const withStats = (f, stats) => {
          const st = stats.get(f.path);
          return st && !st.binary ? { ...f, added: st.added, deleted: st.deleted } : f;
        };
        const scm = this.ctx.scm && this.ctx.scm.get(repo);
        post({ scmMessage: scm ? scm.message : undefined, files: [
          ...s.conflicts.map((e) => ({ status: '!', path: e.path, group: 'merge' })),
          ...s.staged.map((e) => withStats({ status: e.kind === 'renamed' ? 'R' : e.x, path: e.path, origPath: e.origPath, group: 'staged' }, stagedStats)),
          ...s.unstaged.map((e) => withStats({ status: e.y, path: e.path, group: 'unstaged' }, unstagedStats)),
          ...s.untracked.map((e) => ({ status: 'U', path: e.path, group: 'untracked' })),
        ] });
        return;
      }
      if (typeof sha !== 'string' || !/^[0-9a-f]{40,64}$/.test(sha)) return;
      const { parent, files } = await repo.getCommitFiles(sha);
      post({ parent, files });
    } catch (e) {
      log().warn(`Graph files of ${sha}: ${e.message}`);
      post({ files: undefined, error: `Could not list the files: ${e.message}` });
    }
  }

  /** The configured user.email, to mark your own commits ("you"). */
  async userEmail() {
    if (this.meFor !== this.repo) {
      this.me = (await this.repo.getConfig('user.email')) || '';
      this.meFor = this.repo;
    }
    return this.me;
  }

  /** Keyboard route to everything the commit context menu offers. */
  async showActions(m) {
    const shas = (m.shas || []).filter((s) => s !== WORKTREE_SHA);
    if (!shas.length) {
      if (m.sha === WORKTREE_SHA) await vscode.commands.executeCommand('workbench.view.scm');
      return;
    }
    const node = { repoRoot: this.repo.root, sha: shas[shas.length - 1], shas };
    const one = shas.length === 1;
    const items = [
      { label: one ? '$(diff-multiple) Show Changes' : `$(diff-multiple) Show Combined Changes (${shas.length})`, id: one ? 'commitCorner.showCommit' : 'commitCorner.showCommits' },
      ...(one ? [] : [{ label: '$(diff) Show Range Changes', id: 'commitCorner.showCommitRange' }]),
      { label: '$(git-commit) Cherry-pick', id: 'commitCorner.cherryPick' },
      { label: '$(discard) Revert…', id: 'commitCorner.revert' },
      { label: '$(file-code) Create Patch…', id: 'commitCorner.createPatch' },
      ...(one ? [
        { label: '$(check) Checkout (Detached)', id: 'commitCorner.checkoutDetached' },
        { label: '$(git-branch) Create Branch Here…', id: 'commitCorner.createBranch' },
        { label: '$(tag) Create Tag Here…', id: 'commitCorner.createTag' },
        { label: '$(git-merge) Merge into Current Branch…', id: 'commitCorner.merge' },
        { label: '$(git-pull-request) Rebase Current Branch onto This…', id: 'commitCorner.rebase' },
        { label: '$(list-ordered) Interactive Rebase from Here…', id: 'commitCorner.rebaseInteractive' },
        { label: '$(debug-restart) Reset Current Branch to Here…', id: 'commitCorner.reset' },
        { label: '$(fold-up) Squash into Parent', id: 'commitCorner.squashIntoParent' },
        { label: '$(fold-up) Fixup into Parent', id: 'commitCorner.fixupIntoParent' },
        { label: '$(fold-down) Fold Staged Changes into This Commit…', id: 'commitCorner.fixupStagedInto' },
        { label: '$(edit) Reword…', id: 'commitCorner.rewordCommit' },
        { label: '$(trash) Drop…', id: 'commitCorner.dropCommit' },
        { label: '$(compare-changes) Compare with Working Tree', id: 'commitCorner.compareWithWorkingTree' },
        { label: '$(git-compare) Compare with Current Branch', id: 'commitCorner.compareWithCurrent' },
        { label: '$(search) Bisect: This Is Good, HEAD Is Bad', id: 'commitCorner.bisectStart' },
        { label: '$(copy) Copy Message', id: 'commitCorner.copyMessage' },
        { label: '$(github) Open on GitHub', id: 'commitCorner.openCommitOnGitHub' },
      ] : [{ label: '$(fold-up) Squash Selected Commits…', id: 'commitCorner.squashSelected' }]),
      { label: '$(copy) Copy SHA', id: 'commitCorner.copySha' },
    ];
    // History rewrites only for commits in the current branch's history (as the context menu).
    const REWRITES = ['commitCorner.squashIntoParent', 'commitCorner.fixupIntoParent', 'commitCorner.fixupStagedInto', 'commitCorner.rewordCommit', 'commitCorner.dropCommit', 'commitCorner.squashSelected'];
    if (!(await this.allOnHead(shas))) items.splice(0, items.length, ...items.filter((i) => !REWRITES.includes(i.id)));
    if (one) {
      // Compare and bisect, as in the context menu.
      items.push({ label: '$(git-compare) Select for Compare', id: 'commitCorner.compareSelectForCompare' });
      if (this.ctx.pendingCompare) items.push({ label: '$(git-compare) Compare with Selected', id: 'commitCorner.compareWithSelected' });
      const bisecting = this.repo.state && this.repo.state.operation && this.repo.state.operation.kind === 'bisect';
      if (bisecting) {
        items.push({ label: '$(pass) Bisect: Mark Good', id: 'commitCorner.bisectGood' }, { label: '$(error) Bisect: Mark Bad', id: 'commitCorner.bisectBad' });
      }
      const startIdx = items.findIndex((i) => i.id === 'commitCorner.bisectStart');
      if (bisecting && startIdx >= 0) items.splice(startIdx, 1);
      // Branch and tag actions for the refs at this commit (the badges' context menu).
      const refItems = [];
      // Branches, remote branches and tags (not HEAD, fetched pull requests or other refs).
      // The refs at this commit come from git, not from the page (which could label one ref and
      // name another).
      const here = (await this.repo.getRefs()).filter((x) => x.sha === node.sha);
      for (const r of here.filter((x) => ['branch', 'remote', 'tag'].includes(x.type))) {
        const ref = { ...node, ref: r.rev || r.name, type: r.type };
        const current = r.type === 'branch' && this.repo.state && this.repo.state.head.branch === r.name;
        if (r.type === 'branch' && !current) refItems.push({ label: `$(git-branch) Checkout ${escapeIcons(r.name)}`, id: 'commitCorner.checkout', node: ref });
        if (r.type === 'remote') refItems.push({ label: `$(cloud) Checkout ${escapeIcons(r.name)}`, id: 'commitCorner.checkout', node: ref });
        if (!current) {
          refItems.push({ label: `$(git-merge) Merge ${escapeIcons(r.name)} into Current Branch…`, id: 'commitCorner.merge', node: ref });
          refItems.push({ label: `$(git-pull-request) Rebase Current Branch onto ${escapeIcons(r.name)}…`, id: 'commitCorner.rebase', node: ref });
        }
        if (r.type === 'tag') refItems.push({ label: `$(cloud-upload) Push Tag ${escapeIcons(r.name)}…`, id: 'commitCorner.pushTag', node: ref });
        if (r.type === 'branch') refItems.push({ label: `$(git-pull-request-create) Create Pull Request for ${escapeIcons(r.name)}…`, id: 'commitCorner.createPullRequest', node: ref });
        if (!current) refItems.push({ label: `$(trash) Delete ${r.type === 'tag' ? 'Tag' : r.type === 'remote' ? 'Remote Branch' : 'Branch'} ${escapeIcons(r.name)}…`, id: 'commitCorner.graph.deleteRef', node: ref });
      }
      // Another worktree (an agent's) has uncommitted work on this commit: its changes.
      const wipPath = this.wipPaths && this.wipPaths.get(node.sha);
      if (wipPath) refItems.push({ label: `$(diff-multiple) Uncommitted Changes in Worktree ${escapeIcons(require('path').basename(wipPath))}`, id: 'commitCorner.worktreeOpenChanges', node: { repoRoot: this.repo.root, worktreePath: wipPath } });
      if (refItems.length) items.unshift({ label: 'Branches and tags here', kind: vscode.QuickPickItemKind.Separator }, ...refItems, { label: 'Commit', kind: vscode.QuickPickItemKind.Separator });
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: one ? `Commit ${shortSha(node.sha)}` : `${shas.length} selected commits`, matchOnDescription: true });
    if (pick) await vscode.commands.executeCommand(pick.id, pick.node || node);
  }

  async sendDetails(shas, requestId) {
    const repo = this.repo;
    const post = (m) => this.post({ ...m, requestId });
    const real = shas.filter((s) => s !== WORKTREE_SHA);
    // A new selection stops the git work for the previous one (a combined diff replays every commit).
    if (this.detailsController) this.detailsController.abort();
    const controller = new AbortController();
    this.detailsController = controller;
    try {
      if (shas.length === 1 && shas[0] === WORKTREE_SHA) {
        const s = await repo.refreshState();
        const files = [
          ...s.conflicts.map((e) => ({ status: '!', path: e.path, group: 'merge' })),
          ...s.staged.map((e) => ({ status: e.kind === 'renamed' ? 'R' : e.x, path: e.path, origPath: e.origPath, group: 'staged' })),
          ...s.unstaged.map((e) => ({ status: e.y, path: e.path, group: 'unstaged' })),
          ...s.untracked.map((e) => ({ status: 'U', path: e.path, group: 'untracked' })),
        ];
        post({ type: 'details', kind: 'worktree', shas, files });
        return;
      }
      if (real.length === 1) {
        const [{ commit, parent, files }, signature] = await Promise.all([repo.getCommitFiles(real[0]), repo.getSignature(real[0]).catch(() => undefined)]);
        post({ type: 'details', kind: 'commit', shas: real, commit, parent, files, signature, summary: changeSummary(files), me: await this.userEmail() });
      } else if (real.length > 1) {
        const { commits, files, exact, failed, approximate } = await repo.getMultiCommitChanges(real, { signal: controller.signal });
        post({ type: 'details', kind: 'multi', shas: real, commits: commits.map((c) => c.commit), files, exact, failed, approximate, summary: changeSummary(files) });
      } else post({ type: 'details', kind: 'none' });
    } catch (e) {
      if (e && e.code === 'Cancelled') return;
      post({ type: 'details', kind: 'error', message: e.message });
    }
  }

  async openFile(m) {
    const repo = this.repo;
    // The page says which file of which commit: revisions must be SHAs (or none), paths plain
    // repository-relative paths, groups and statuses ones we know.
    const f = m.file;
    if (!f || typeof f !== 'object' || !pagePath(f.path)) return;
    for (const p of [f.origPath, f.beforePath, f.afterPath]) if (p !== undefined && p !== null && !pagePath(p)) return;
    for (const r of [m.parent, f.beforeRef, f.afterRef]) if (r !== undefined && r !== null && !isSha(r)) return;
    if (f.group !== undefined && !['merge', 'staged', 'unstaged', 'untracked'].includes(f.group)) return;
    if (f.status !== undefined && !(typeof f.status === 'string' && /^[ACDMRTUX!?]$/.test(f.status))) return;
    if (!['worktree', 'commit', 'multi'].includes(m.kind)) return;
    if (m.kind === 'multi' && !(Array.isArray(m.shas) && m.shas.length)) return;
    const keepFocus = m.keepFocus === true;
    if (m.kind === 'worktree') {
      await vscode.commands.executeCommand('commitCorner.openResource', { repoRoot: repo.root, path: f.path, origPath: f.origPath, group: f.group, status: f.status, preserveFocus: keepFocus });
      return;
    }
    if (m.kind === 'commit') {
      await openDiff(repo, {
        path: f.path,
        leftRef: f.status === 'A' ? null : m.parent || EMPTY_TREE,
        leftPath: f.origPath || f.path,
        rightRef: f.status === 'D' ? null : m.sha,
        title: `${f.path.split('/').pop()} (${shortSha(m.sha)})`,
        preserveFocus: keepFocus,
      });
      return;
    }
    if (m.kind === 'multi') {
      await openDiff(repo, {
        path: f.path,
        leftRef: f.beforeRef === null ? null : f.beforeRef || EMPTY_TREE,
        leftPath: f.beforePath,
        rightRef: f.afterRef,
        rightPath: f.afterPath,
        title: `${f.path.split('/').pop()} (${m.shas.length} commits)`,
      });
    }
  }

  /** Normalize the argument of a webview context menu command into a node. */
  nodeFromContext(arg) {
    const node = { repoRoot: this.repo.root };
    if (!arg) return node;
    // Context-menu data comes from the page: only SHAs and plain ref names are taken.
    if (isSha(arg.sha)) node.sha = arg.sha;
    if (typeof arg.ref === 'string' && arg.ref && !arg.ref.startsWith('-') && !/[\u0000-\u0020\u007f~^:?*[\\]/.test(arg.ref)) {
      node.ref = arg.ref;
      node.type = ['branch', 'remote', 'tag'].includes(arg.refType) ? arg.refType : undefined;
    }
    // When the clicked commit is part of the multi-selection, act on the whole selection. The
    // webview sends its selection along: the host's copy may lag behind by the details debounce.
    const selection = Array.isArray(arg.selection) ? arg.selection.filter(isSha) : this.selection;
    if (node.sha && selection.includes(node.sha) && selection.length > 1) node.shas = selection.slice();
    else if (node.sha) node.shas = [node.sha];
    return node;
  }

  dispose() {
    if (this.genCts) this.genCts.cancel();
    if (this.disposed) return;
    this.disposed = true;
    if (GraphPanel.current === this) GraphPanel.current = undefined;
    if (GraphPanel.sidebar === this) GraphPanel.sidebar = undefined;
    if (this.detailsController) this.detailsController.abort();
    if (this.loadController) this.loadController.abort();
    this.disposables.forEach((d) => d.dispose());
  }
}
/** Per repository: the draft a graph last put into Source Control's box (was it edited there since?). */
GraphPanel.draftSent = new Map();

/**
 * A WebviewView dressed up as the WebviewPanel members GraphPanel uses.
 * @param {vscode.WebviewView} view
 */
function sidebarSurface(view) {
  const surface = {
    webview: view.webview,
    get visible() {
      return view.visible;
    },
    set description(d) {
      view.description = d;
    },
    reveal: () => view.show(true),
    /** Give the view keyboard focus (VS Code focuses the page's frame). */
    focus: () => view.show(false),
    dispose: () => {},
    onDidDispose: (cb) => view.onDidDispose(cb),
    onDidChangeViewState: (cb) => view.onDidChangeVisibility(() => cb({ webviewPanel: surface })),
  };
  return surface;
}

/** Quick pick for what the graph shows: all, local, current, first parent, or one branch. */
async function pickGraphFilter(repo, current) {
  const refs = (await repo.getRefs()).filter((r) => r.type === 'branch' || r.type === 'remote');
  const items = [
    { label: '$(git-merge) All branches', filter: { kind: 'all' } },
    { label: '$(git-branch) Local branches', filter: { kind: 'local' } },
    { label: '$(target) Current branch', filter: { kind: 'current' } },
    { label: '$(list-flat) Current branch, first parent only', filter: { kind: 'firstParent' } },
    { label: 'Branch', kind: vscode.QuickPickItemKind.Separator },
    ...refs.map((r) => ({ label: `$(${r.type === 'remote' ? 'cloud' : 'git-branch'}) ${escapeIcons(r.name)}`, filter: { kind: 'ref', ref: r.rev || r.name } })),
  ];
  for (const i of items) if (i.filter && i.filter.kind === current.kind && i.filter.ref === current.ref) i.description = 'shown now';
  const pick = await vscode.window.showQuickPick(items, { title: 'Show in the graph', placeHolder: 'Which history to show' });
  return pick && pick.filter;
}

/** What a list of changed files adds up to: files per kind of change and changed lines. */
function changeSummary(files) {
  const count = (re) => files.filter((f) => re.test(f.status)).length;
  return {
    files: files.length,
    added: count(/^[AC]/),
    modified: count(/^[MT]/),
    deleted: count(/^D/),
    renamed: count(/^R/),
    additions: files.reduce((n, f) => n + (f.added || 0), 0),
    deletions: files.reduce((n, f) => n + (f.deleted || 0), 0),
  };
}

/** Counts for the working-tree row's chips. */
function worktreeCounts(state) {
  if (!state) return undefined;
  return { staged: state.staged.length, unstaged: state.unstaged.length, untracked: state.untracked.length, conflicts: state.conflicts.length };
}

function worktreeSubject(state) {
  if (!state) return undefined;
  const dirty = state.staged.length + state.unstaged.length + state.untracked.length + state.conflicts.length;
  if (!dirty) return undefined;
  return `Uncommitted changes (${state.staged.length} staged, ${state.unstaged.length + state.untracked.length} unstaged${state.conflicts.length ? `, ${state.conflicts.length} conflicts` : ''})`;
}

/** Compact row for the webview. */
function row(c, layoutRow, info) {
  return {
    sha: c.sha,
    parents: info.parents || c.parents,
    subject: info.subject,
    author: info.authorName,
    email: info.authorEmail,
    date: info.authorDate,
    cdate: info.commitDate,
    refs: (info.refs || []).map((r) => ({ name: r.name, rev: r.rev || r.name, type: r.type, isHead: !!r.isHead })),
    g: layoutRow,
    ...(info.wt ? { wt: info.wt } : {}),
  };
}

/** @param {import('../context').Context} ctx */
function register(ctx) {
  const { manager } = ctx;
  const cmd = ctx.command;

  cmd('commitCorner.showGraph', async (arg) => {
    const repo = await manager.pick(arg);
    if (!repo) return;
    await GraphPanel.show(ctx, repo, { revealSha: arg && arg.revealSha, includeRefs: arg && arg.includeRefs, filter: arg && arg.filter, search: arg && arg.search });
  });

  // Context-menu commands from the graph webview: translate the menu context
  // into the node shape the regular commands understand, then delegate.
  const delegate = (id, target, needsSha = true) => cmd(id, async (arg) => {
    const panel = GraphPanel.forContext(arg);
    if (!panel) return;
    const node = panel.nodeFromContext(arg);
    if (needsSha && !node.sha && !node.ref) return;
    await vscode.commands.executeCommand(target, node);
  });
  delegate('commitCorner.graph.showCommit', 'commitCorner.graph.openSelection');
  // The uncommitted work of the worktree at this commit (path looked up on the host).
  cmd('commitCorner.graph.worktreeChanges', async (arg) => {
    const panel = GraphPanel.forContext(arg);
    const node = panel && panel.nodeFromContext(arg);
    const p = node && node.sha && panel.wipPaths && panel.wipPaths.get(node.sha);
    if (p) await vscode.commands.executeCommand('commitCorner.worktreeOpenChanges', { repoRoot: panel.repo.root, worktreePath: p });
  });
  // A summary of the selected commits (or the one under the cursor), by a language model.
  cmd('commitCorner.graph.summarize', async (arg) => {
    const panel = GraphPanel.forContext(arg);
    const node = panel && panel.nodeFromContext(arg);
    const shas = node ? (node.shas && node.shas.length ? node.shas : [node.sha]).filter(isSha) : [];
    if (!shas.length) return;
    await require('./summaryPanel').SummaryPanel.show(ctx, require('../ai').commitsSource(panel.repo, shas));
  });
  delegate('commitCorner.graph.checkout', 'commitCorner.checkoutDetached');
  delegate('commitCorner.graph.createBranch', 'commitCorner.createBranch');
  delegate('commitCorner.graph.createTag', 'commitCorner.createTag');
  delegate('commitCorner.graph.cherryPick', 'commitCorner.cherryPick');
  delegate('commitCorner.graph.revert', 'commitCorner.revert');
  delegate('commitCorner.graph.reset', 'commitCorner.reset');
  delegate('commitCorner.graph.merge', 'commitCorner.merge');
  delegate('commitCorner.graph.rebase', 'commitCorner.rebase');
  delegate('commitCorner.graph.rebaseInteractive', 'commitCorner.rebaseInteractive');
  delegate('commitCorner.graph.copySha', 'commitCorner.copySha');
  delegate('commitCorner.graph.copyMessage', 'commitCorner.copyMessage');
  delegate('commitCorner.graph.openOnGitHub', 'commitCorner.openCommitOnGitHub');
  delegate('commitCorner.graph.compareWithWorkingTree', 'commitCorner.compareWithWorkingTree');
  delegate('commitCorner.graph.compareWithCurrent', 'commitCorner.compareWithCurrent');
  delegate('commitCorner.graph.selectForCompare', 'commitCorner.compareSelectForCompare');
  delegate('commitCorner.graph.compareWithSelected', 'commitCorner.compareWithSelected');
  delegate('commitCorner.graph.refCheckout', 'commitCorner.checkout');
  delegate('commitCorner.graph.refDelete', 'commitCorner.graph.deleteRef');
  delegate('commitCorner.graph.createPullRequest', 'commitCorner.createPullRequest');
  delegate('commitCorner.graph.createPatch', 'commitCorner.createPatch');
  delegate('commitCorner.graph.bisectStart', 'commitCorner.bisectStart');
  delegate('commitCorner.graph.bisectGood', 'commitCorner.bisectGood');
  delegate('commitCorner.graph.bisectBad', 'commitCorner.bisectBad');
  delegate('commitCorner.graph.squash', 'commitCorner.squashIntoParent');
  delegate('commitCorner.graph.squashSelected', 'commitCorner.squashSelected');
  delegate('commitCorner.graph.fixupStagedInto', 'commitCorner.fixupStagedInto');
  delegate('commitCorner.graph.fixup', 'commitCorner.fixupIntoParent');
  delegate('commitCorner.graph.reword', 'commitCorner.rewordCommit');
  delegate('commitCorner.graph.drop', 'commitCorner.dropCommit');

  cmd('commitCorner.graph.openSelection', async (node) => {
    const panel = GraphPanel.forContext(node);
    if (!panel || !node) return;
    const shas = node.shas || [node.sha];
    if (shas.length > 1) await showCommits(panel.repo, shas);
    else await showCommit(panel.repo, shas[0]);
  });

  cmd('commitCorner.graph.showRange', async (arg) => {
    const panel = GraphPanel.forContext(arg);
    if (!panel) return;
    const node = panel.nodeFromContext(arg);
    if (node.shas && node.shas.length) await showRange(panel.repo, node.shas);
  });

  cmd('commitCorner.graph.deleteRef', async (node) => {
    if (!node || !node.ref) return;
    if (node.type === 'tag') await vscode.commands.executeCommand('commitCorner.deleteTag', node);
    else if (node.type === 'remote') await vscode.commands.executeCommand('commitCorner.deleteRemoteBranch', node);
    else await vscode.commands.executeCommand('commitCorner.deleteBranch', node);
  });

  cmd('commitCorner.graph.refresh', async () => {
    if (GraphPanel.current) await GraphPanel.current.load({ keepScroll: true });
  });

  // ---- the compact Graph view in the sidebar ----------------------------------
  const sidebarProvider = {
    async resolveWebviewView(view) {
      require('../sidebar').sidebarShown();
      await manager.ready;
      const repo = manager.active || manager.repositories[0];
      const surface = sidebarSurface(view);
      if (GraphPanel.sidebar) GraphPanel.sidebar.dispose();
      GraphPanel.sidebar = new GraphPanel(ctx, surface, repo, {}, { compact: true });
      // A repository opened later (init, clone, a folder added) takes the empty sidebar over.
      if (!repo) {
        const sidebar = GraphPanel.sidebar;
        const sub = manager.onDidOpen((r) => {
          sub.dispose();
          if (GraphPanel.sidebar === sidebar && !sidebar.repo) sidebar.setRepo(r);
        });
        sidebar.disposables.push(sub);
      }
    },
  };
  const viewRegistration = vscode.window.registerWebviewViewProvider('commitCorner.graphView', sidebarProvider);
  // Ctrl+Alt+G V: show the sidebar Graph with the keyboard in its list. The view is not kept
  // while hidden, so when it is (re)created the page asks for the focus once it is ready.
  cmd('commitCorner.graphView.focusList', async () => {
    GraphPanel.focusSidebarPending = true;
    // One view at a time: the Graph alone (the other views are a click away).
    await require('../sidebar').showView('graphView', { focus: false });
    await vscode.commands.executeCommand('commitCorner.graphView.focus');
    const g = GraphPanel.sidebar;
    if (g && g.layout) {
      GraphPanel.focusSidebarPending = false;
      g.focusList();
    }
  });
  const sidebarDo = (fn) => async () => {
    if (!GraphPanel.sidebar) await vscode.commands.executeCommand('commitCorner.graphView.focus');
    if (GraphPanel.sidebar) await fn(GraphPanel.sidebar);
  };
  cmd('commitCorner.graphView.refresh', sidebarDo((g) => g.load({ keepScroll: true })));
  cmd('commitCorner.graphView.showAll', sidebarDo(async (g) => {
    g.filter = { kind: 'all' };
    g.includeRefs = [];
    await g.load();
  }));
  cmd('commitCorner.graphView.sinceLastLook', sidebarDo((g) => g.showChangesSinceSeen()));
  cmd('commitCorner.graphView.search', sidebarDo((g) => {
    g.panel.reveal();
    g.post({ type: 'focusSearch' });
  }));
  cmd('commitCorner.graphView.filter', sidebarDo(async (g) => {
    const filter = await pickGraphFilter(g.repo, g.filter);
    if (!filter) return;
    g.filter = filter;
    g.includeRefs = [];
    await g.load();
  }));
  cmd('commitCorner.graphView.openInEditor', sidebarDo(async (g) => {
    const panel = await GraphPanel.show(ctx, g.repo, { revealSha: g.selection[g.selection.length - 1] });
    if (panel.filter.kind !== g.filter.kind || panel.filter.ref !== g.filter.ref) {
      panel.filter = g.filter;
      await panel.load();
    }
  }));

  ctx.own(viewRegistration);
  return vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
    async deserializeWebviewPanel(panel, state) {
      await manager.ready;
      const repo = (state && state.repoRoot && manager.getRepository(state.repoRoot)) || manager.active || manager.repositories[0];
      if (!repo) {
        panel.dispose();
        return;
      }
      GraphPanel.current = new GraphPanel(ctx, panel, repo, state || {});
    },
  });
}

module.exports = { pagePath, pageArgs, GraphPanel, register, WORKTREE_SHA };
