'use strict';

const vscode = require('vscode');
const notify = require('../notify');
const { TreeProvider, MessageNode, GroupNode, CommitNode, fileNodes, fingerprintOf } = require('./nodes');
const viewed = require('../viewed');
const { githubWebUrl, githubPullUrl } = require('../../git/remoteUrl');
const { shortSha, config, withProgress, confirm, showError, escapeMarkdown, formatDate, absoluteDate, log, escapeIcons } = require('../util');
const github = require('../github');
const { avatarUri } = require('../avatars');
const { openMultiDiff } = require('../diffs');
const { pickRef, inputBranchName } = require('../pickers');

/**
 * GitHub pull requests. The diffs always come from git: GitHub publishes every
 * PR as refs/pull/<n>/head (and refs/pull/<n>/merge while it is open and
 * mergeable); we fetch the ones you open into a private ref namespace and
 * diff them from the merge base like GitHub's "Files changed" tab.
 *
 * The list and its metadata (title, author, state, reviews, checks) come from
 * the GitHub REST API when it is enabled and reachable (an explicit owner
 * exception, see ../github/index.js); otherwise from `git ls-remote`, which only
 * knows numbers and head commits.
 */

const STATE_ICONS = {
  open: ['git-pull-request', 'gitDecoration.addedResourceForeground'],
  draft: ['git-pull-request-draft', 'descriptionForeground'],
  merged: ['git-merge', 'charts.purple'],
  closed: ['git-pull-request-closed', 'gitDecoration.deletedResourceForeground'],
};

class PullRequestNode {
  /** @param {object} [meta] a pull request from the GitHub API (see ../github/pulls.js pullSummary) */
  constructor(view, repo, remote, pr, fetched, branch, meta, slug) {
    this.branch = branch;
    this.view = view;
    this.repo = repo;
    this.repoRoot = repo.root;
    this.remote = remote;
    this.number = pr.number;
    this.headSha = pr.head;
    this.hasMergeRef = !!pr.merge;
    this.fetched = fetched; // {sha, subject} | undefined
    this.meta = meta;
    this.slug = slug;
    if (meta) {
      this.timelineDate = meta.updatedAt;
      this.timelineNoun = 'pull request';
    }
  }

  getTreeItem() {
    if (this.meta) return this.metaTreeItem();
    const item = new vscode.TreeItem(`#${this.number}`, vscode.TreeItemCollapsibleState.Collapsed);
    const upToDate = this.fetched && this.fetched.sha === this.headSha;
    const from = this.branch ? `${this.branch} • ` : '';
    item.description = from + (this.fetched ? `${this.fetched.subject}${upToDate ? '' : ' (updated on remote)'}` : `${shortSha(this.headSha)} • not fetched yet`);
    item.iconPath = new vscode.ThemeIcon(this.hasMergeRef ? 'git-pull-request' : 'git-pull-request-closed', this.hasMergeRef ? new vscode.ThemeColor('gitDecoration.addedResourceForeground') : undefined);
    item.tooltip = new vscode.MarkdownString([
      `**#${this.number}** on \`${this.remote}\` — head \`${shortSha(this.headSha)}\``,
      this.hasMergeRef ? 'GitHub publishes a test-merge ref for this PR, which usually means it is **open** and mergeable.' : 'No test-merge ref: the PR is probably closed or merged (or has conflicts).',
      'Expand to fetch it and see its commits and files.',
    ].join('\n\n'));
    item.contextValue = 'pullRequest';
    item.id = `${this.repoRoot}:pr:${this.remote}:${this.number}`;
    return item;
  }

  /** Title, author, age, state and branches, as GitHub shows them. */
  metaTreeItem() {
    const m = this.meta;
    const item = new vscode.TreeItem(`#${this.number}  ${m.title}`, vscode.TreeItemCollapsibleState.Collapsed);
    const upToDate = !this.fetched || this.fetched.sha === this.headSha;
    item.description = [m.author, formatDate(m.updatedAt), `${m.baseRef} ← ${m.headOwner && this.slug && m.headOwner !== this.slug.owner ? `${m.headOwner}:` : ''}${m.headRef}`, upToDate ? '' : 'updated since fetched'].filter(Boolean).join(' • ');
    const [icon, color] = STATE_ICONS[m.state] || STATE_ICONS.open;
    item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    const md = new vscode.MarkdownString(undefined, true);
    md.supportThemeIcons = true;
    md.appendMarkdown(`$(${icon}) **#${this.number} ${escapeMarkdown(m.title)}**  \n`);
    md.appendMarkdown(`${escapeMarkdown(m.state)} · $(person) ${escapeMarkdown(m.author)} · opened ${escapeMarkdown(formatDate(m.createdAt))} · updated ${escapeMarkdown(formatDate(m.updatedAt))} (${escapeMarkdown(absoluteDate(m.updatedAt))})  \n`);
    md.appendMarkdown(`$(git-branch) ${escapeMarkdown(m.baseRef)} ← ${escapeMarkdown(m.headOwner ? `${m.headOwner}:` : '')}${escapeMarkdown(m.headRef)} · head \`${shortSha(this.headSha)}\``);
    if (m.labels.length) md.appendMarkdown(`  \n$(tag) ${m.labels.map(escapeMarkdown).join(', ')}`);
    if (m.body.trim()) {
      md.appendMarkdown('\n\n---\n\n');
      // The description is someone else's text: shown as plain text, never as markdown.
      md.appendText(m.body.length > 1500 ? `${m.body.slice(0, 1500)}…` : m.body);
    }
    item.tooltip = md;
    item.contextValue = 'pullRequest';
    item.id = `${this.repoRoot}:pr:${this.remote}:${this.number}`;
    item.accessibilityInformation = { label: `Pull request ${this.number}, ${m.title}, ${m.state}, by ${m.author}, updated ${formatDate(m.updatedAt)}` };
    return item;
  }

  /** Reviews and checks (GitHub API), as the first rows of an expanded pull request. */
  async statusNodes() {
    if (!this.meta || !this.slug) return [];
    try {
      const st = await github.pullRequestStatus(this.slug.owner, this.slug.repo, this.number, this.headSha);
      const out = [];
      if (st.changesRequestedBy.length) out.push(new MessageNode(`Changes requested by ${st.changesRequestedBy.join(', ')}`, 'request-changes'));
      if (st.approvedBy.length) out.push(new MessageNode(`Approved by ${st.approvedBy.join(', ')}`, 'pass-filled'));
      if (!st.changesRequestedBy.length && !st.approvedBy.length) out.push(new MessageNode('No reviews yet', 'eye'));
      if (st.checks.length) {
        const n = (s) => st.checks.filter((c) => c.state === s);
        const failed = n('failure');
        const parts = [`${n('success').length} passed`, failed.length ? `${failed.length} failed` : '', n('pending').length ? `${n('pending').length} running` : ''].filter(Boolean);
        const node = new MessageNode(`Checks: ${parts.join(', ')}${failed.length ? ` (${failed.map((c) => c.name).slice(0, 3).join(', ')}${failed.length > 3 ? ', …' : ''})` : ''}`, failed.length ? 'error' : n('pending').length ? 'sync' : 'pass');
        out.push(node);
      }
      return out;
    } catch (e) {
      log().info(`PR #${this.number} status: ${e.message}`);
      return [];
    }
  }

  async getChildren() {
    const [info, status] = await Promise.all([this.view.loadDetails(this), this.statusNodes()]);
    if (!info) return [...status, new MessageNode('Could not fetch this pull request', 'error')];
    const { headSha, baseRef, baseTip, mergeBase, merged, commits, files } = info;
    const baseLabel = `${baseRef}${baseTip ? ` @ ${shortSha(baseTip)}` : ''}${merged ? ' (already merged)' : ''}`;
    const scope = `pr:${this.repoRoot}:${this.remote}#${this.number}`;
    const ids = await this.repo.changedBlobIds(mergeBase, headSha).catch(() => new Map());
    const marks = files.map((f) => ({ path: f.path, fingerprint: fingerprintOf(ids, f) }));
    // The group redraws itself when a checkbox changes (its count, its files): not the whole
    // pull request, whose reviews and checks would be fetched again.
    const filesGroup = new GroupNode(`Files changed (${files.length})`, () => fileNodes(this.repo, files, { leftRef: mergeBase, rightRef: headSha, diffLabel: `#${this.number}` }, { tree: true, viewed: { scope, ids, owner: filesGroup, provider: this.view } }), {
      icon: 'files',
      description: () => {
        const seen = viewed.get().count(scope, marks);
        // The same words as "Changes vs …": "1/3 viewed", "all 3 viewed".
        return !seen ? undefined : seen === files.length ? (seen === 1 ? 'viewed' : `all ${seen} viewed`) : `${seen}/${files.length} viewed`;
      },
      contextValue: 'viewedGroup:pr',
      props: { repoRoot: this.repoRoot, prNumber: this.number, number: this.number, remote: this.remote, viewedScope: scope, viewedFiles: marks, viewedProvider: this.view },
    });
    filesGroup.viewedOwner = filesGroup;
    return [
      ...status,
      new MessageNode(`Base: ${baseLabel} • merge base ${shortSha(mergeBase)}`, 'git-merge', { command: 'commitCorner.prChangeBase', title: 'Change Base', arguments: [this] }),
      new GroupNode(`Commits (${commits.length})`, commits.map((c) => new CommitNode(this.repo, c)), { icon: 'git-commit', collapsed: true }),
      // Open when the pull request is opened, as a folder tree, each file
      // with a "Viewed" checkbox like GitHub's (unchecked again when a push changes the file).
      filesGroup,
    ];
  }
}

/** The empty "open only" list: a click (or Enter) shows the closed and merged ones too. */
function showAllNode(text) {
  return new MessageNode(text, 'filter', { command: 'commitCorner.prShowAll', title: 'Show All Pull Requests' });
}

class PullRequestsView extends TreeProvider {
  /** @param {import('../model').RepositoryManager} manager */
  constructor(manager, extContext) {
    super();
    this.manager = manager;
    this.extContext = extContext;
    /** repoRoot -> remote -> {prs, error, limit} */
    this.lists = new Map();
    /** `${root}:${remote}:${n}` -> details */
    this.details = new Map();
    /** `${root}:${remote}:${n}` -> GitHub API summary, when listed through the API */
    this.metas = new Map();
    this.view = require('../util').registerTreeView('commitCorner.pullRequests', vscode.window.createTreeView('commitCorner.pullRequests', { treeDataProvider: this, canSelectMany: true, showCollapseAll: true, manageCheckboxStateManually: true }));
    this.disposables = [this.view, manager.onDidChangeActive(() => this.refresh()), viewed.watchCheckboxes(this.view, this)];
    /** Show only PRs that still have GitHub's test-merge ref (in practice: open ones). */
    // Open pull requests by default; "Show All Pull Requests" (view menu) lists closed and merged ones too.
    this.openOnly = extContext.workspaceState.get('prOpenOnly', true);
    vscode.commands.executeCommand('setContext', 'commitCorner.prOpenOnly', this.openOnly);
  }

  /**
   * Remotes to list PRs from: those recognisably on GitHub. If none are (an
   * SSH host alias such as git@github-work:org/repo), every remote is tried —
   * refs/pull/* works through any alias.
   */
  async githubRemotes(repo) {
    const remotes = await repo.getRemotes();
    const github = remotes.filter((r) => githubWebUrl(r.fetchUrl));
    return github.length ? github : remotes;
  }

  async getRoots() {
    const repo = this.manager.active;
    if (!repo) return [];
    const remotes = await this.githubRemotes(repo);
    if (!remotes.length) return [new MessageNode('This repository has no remotes', 'info')];
    const groups = [];
    for (const remote of remotes) {
      const nodes = await this.remoteChildren(repo, remote.name, remote);
      if (remotes.length === 1) return nodes;
      groups.push(new GroupNode(remote.name, nodes, { icon: 'cloud', props: { repoRoot: repo.root, remote: remote.name } }));
    }
    return groups;
  }

  listState(repo, remote) {
    if (!this.lists.has(repo.root)) this.lists.set(repo.root, new Map());
    const m = this.lists.get(repo.root);
    if (!m.has(remote)) m.set(remote, { prs: undefined, error: undefined, limit: config().get('pullRequests.pageSize', 50) });
    return m.get(remote);
  }

  /**
   * Pull requests of a remote from the GitHub API, or undefined when the API is off or not
   * available (then the git listing is used). Remembers why, to say so in the view.
   */
  async apiChildren(repo, remote, remoteInfo) {
    const st = this.listState(repo, remote);
    const slug = remoteInfo && github.slugOf(githubWebUrl(remoteInfo.fetchUrl));
    if (!github.enabled() || !slug) return undefined;
    try {
      const { prs, more } = await github.listPullRequests(slug.owner, slug.repo, this.openOnly ? 'open' : 'all', st.limit);
      st.apiError = undefined;
      const fetched = await repo.getFetchedPullRequests(remote);
      for (const p of prs) this.metas.set(`${repo.root}:${remote}:${p.number}`, p);
      if (!prs.length) return [this.openOnly ? showAllNode('No open pull requests · Show all') : new MessageNode('No pull requests', 'info')];
      const nodes = prs.map((p) => new PullRequestNode(this, repo, remote, { number: p.number, head: p.headSha, merge: p.state === 'open' || p.state === 'draft' }, fetched.get(p.number), undefined, p, slug));
      if (more) nodes.push(new MessageNode('Show more (older)', 'ellipsis', { command: 'commitCorner.prShowMore', title: 'Show more', arguments: [{ repoRoot: repo.root, remote }] }));
      return nodes;
    } catch (e) {
      st.apiError = e;
      log().info(`GitHub API for ${slug.owner}/${slug.repo}: ${e.message}`);
      return undefined;
    }
  }

  async remoteChildren(repo, remote, remoteInfo) {
    const fromApi = await this.apiChildren(repo, remote, remoteInfo);
    if (fromApi) return fromApi;
    const st = this.listState(repo, remote);
    // Without the API (off, offline, or a private repository while signed out): git's listing.
    const hint = st.apiError && (st.apiError.status === 404 || st.apiError.status === 401 || st.apiError.status === 403)
      ? [new MessageNode('Sign in to GitHub for titles, authors, reviews and checks', 'github', { command: 'commitCorner.githubSignIn', title: 'Sign In' })]
      : [];
    return [...hint, ...(await this.gitChildren(repo, remote))];
  }

  async gitChildren(repo, remote) {
    const st = this.listState(repo, remote);
    // A listing older than a few minutes is refreshed when the view is shown again; within that,
    // the cached list is used (large remotes advertise many refs).
    if (st.prs && Date.now() - (st.loadedAt || 0) > 5 * 60e3) st.prs = undefined;
    if (!st.prs && !st.error) {
      if (!config().get('pullRequests.listOnOpen', true)) {
        return [new MessageNode('List pull requests (runs git ls-remote)', 'cloud-download', { command: 'commitCorner.prRefresh', title: 'List', arguments: [{ repoRoot: repo.root, remote }] })];
      }
      // Automatic (on open): never pop up credential dialogs for it.
      await this.loadList(repo, remote, true);
    }
    if (st.error) return [new MessageNode(`Could not list pull requests: ${st.error}`, 'error', { command: 'commitCorner.prRefresh', title: 'Retry', arguments: [{ repoRoot: repo.root, remote }] })];
    if (!st.prs.length) return [new MessageNode('No pull requests published on this remote', 'info')];
    const fetched = await repo.getFetchedPullRequests(remote);
    // Without the API there are no titles; a remote branch at the PR's head names it well enough.
    const branchAt = new Map();
    for (const r of await repo.getRefs()) if (r.type === 'remote' && r.name.startsWith(`${remote}/`)) branchAt.set(r.sha, r.name.slice(remote.length + 1));
    const prs = this.openOnly ? st.prs.filter((pr) => pr.merge) : st.prs;
    if (!prs.length) return [showAllNode('No open pull requests · Show all')];
    const nodes = prs.slice(0, st.limit).map((pr) => new PullRequestNode(this, repo, remote, pr, fetched.get(pr.number), branchAt.get(pr.head)));
    if (prs.length > st.limit) {
      nodes.push(new MessageNode(`Show more (${prs.length - st.limit} older)`, 'ellipsis', { command: 'commitCorner.prShowMore', title: 'Show more', arguments: [{ repoRoot: repo.root, remote }] }));
    }
    return nodes;
  }

  async loadList(repo, remote, quiet) {
    const st = this.listState(repo, remote);
    try {
      st.prs = await repo.listPullRequests(remote, { timeout: 60e3, quiet });
      st.loadedAt = Date.now();
      st.error = undefined;
    } catch (e) {
      st.prs = undefined;
      st.error = (e.message || String(e)).split('\n')[0];
    }
  }

  baseKey(repo, remote, number) {
    return `prBase:${repo.root}:${remote}:${number}`;
  }

  /** Fetch a PR if needed (once per head SHA) and compute its commits/files relative to the base. */
  async loadDetails(node) {
    const { repo, remote, number } = node;
    try {
      let headSha = node.fetched && node.fetched.sha;
      if (!headSha || headSha !== node.headSha) {
        headSha = await withProgress(`Fetching pull request #${number}…`, (signal) => repo.fetchPullRequest(remote, number, { withMerge: node.hasMergeRef, signal, timeout: 120e3 }));
        const c = await repo.getCommit(headSha);
        node.fetched = { sha: headSha, subject: c.subject };
        // The row itself said "not fetched yet": draw it again (after this expansion finishes).
        if (node.getTreeItem) setTimeout(() => this._onDidChangeTreeData.fire(node), 0);
      }
      return await this.computeDetails(repo, remote, number, headSha);
    } catch (e) {
      showError(e, `Fetch PR #${number}`);
      return undefined;
    }
  }

  async computeDetails(repo, remote, number, headSha) {
    // The base you chose, else GitHub's (the PR's base branch from the API, the test merge, or
    // the remote's default branch fetched fresh).
    const meta = this.metas.get(`${repo.root}:${remote}:${number}`);
    const preferred = this.extContext.workspaceState.get(this.baseKey(repo, remote, number));
    const key = `${repo.root}:${remote}:${number}`;
    const cached = this.details.get(key);
    if (cached && cached.headSha === headSha && cached.preferred === preferred) return cached;
    const { baseRef, baseTip, mergeBase, merged } = await repo.resolvePullRequestBase(remote, number, headSha, preferred, { baseBranch: meta && meta.baseRef });
    const commits = mergeBase ? await repo.log({ revs: [headSha, `^${mergeBase}`], maxCount: 500 }) : [];
    const files = mergeBase ? await repo.diffFiles(mergeBase, headSha) : [];
    const details = { headSha, baseRef, baseTip, mergeBase, merged, commits, files, number, remote, preferred };
    this.details.set(key, details);
    return details;
  }

  dispose() {
    super.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

/** @param {import('../context').Context} ctx */
function register(ctx, view) {
  const { manager } = ctx;
  const cmd = ctx.command;

  cmd('commitCorner.prRefresh', async (arg) => {
    const repo = await manager.pick(arg);
    if (!repo) return;
    const remotes = arg && arg.remote ? [arg.remote] : (await view.githubRemotes(repo)).map((r) => r.name);
    await withProgress('Listing pull requests…', () => Promise.all(remotes.map((r) => view.loadList(repo, r))), vscode.ProgressLocation.Window);
    view.refresh();
  });

  const setOpenOnly = async (value) => {
    view.openOnly = value;
    await ctx.extContext.workspaceState.update('prOpenOnly', value);
    vscode.commands.executeCommand('setContext', 'commitCorner.prOpenOnly', value);
    view.refresh();
  };
  cmd('commitCorner.prShowOpenOnly', () => setOpenOnly(true));
  cmd('commitCorner.prShowAll', () => setOpenOnly(false));

  cmd('commitCorner.prShowMore', (arg) => {
    const repo = manager.getRepository(arg.repoRoot);
    const st = view.listState(repo, arg.remote);
    st.limit += config().get('pullRequests.pageSize', 50);
    view.refresh();
  });

  cmd('commitCorner.prFetchAll', async (arg) => {
    const repo = await manager.pick(arg);
    if (!repo) return;
    const remotes = await view.githubRemotes(repo);
    if (!remotes.length) return;
    if (!(await confirm('Fetch the head of every pull request?', 'Fetch All', 'On big repositories this can download a lot. Afterwards every PR shows its title (latest commit subject).'))) return;
    await withProgress('Fetching all pull requests…', (signal) => Promise.all(remotes.map((r) => repo.fetchAllPullRequests(r.name, signal))));
    view.refresh();
  });

  /**
   * A pull request of `remote`: picked from the ones the view has listed (titles and authors
   * when the GitHub API listed them), or typed as a number.
   */
  async function pickPrNumber(repo, remote) {
    const items = [];
    const listed = new Set();
    for (const [key, p] of view.metas) {
      if (key !== `${repo.root}:${remote}:${p.number}`) continue;
      listed.add(p.number);
      items.push({
        label: `$(${(STATE_ICONS[p.state] || STATE_ICONS.open)[0]}) #${p.number} ${escapeIcons(p.title)}`,
        description: `${escapeIcons(p.author)}${p.updatedAt ? ` · ${formatDate(p.updatedAt)}` : ''}`,
        detail: escapeIcons(p.headRef && p.baseRef ? `${p.headRef} → ${p.baseRef} · ${p.state}` : p.state),
        number: p.number,
      });
    }
    const st = view.listState(repo, remote);
    for (const pr of (st.prs || []).filter((x) => !listed.has(x.number))) {
      listed.add(pr.number);
      items.push({ label: `$(git-pull-request) #${pr.number}`, description: `${shortSha(pr.head)}${pr.merge ? ' · open' : ''}`, number: pr.number });
    }
    // The listed pull requests first; typing a number that is not listed offers it on top.
    const qp = vscode.window.createQuickPick();
    qp.placeholder = items.length ? 'Pull request: type to filter by number, title or author, or type any PR number' : 'Pull request number';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    const update = () => {
      const typed = /^#?(\d{1,9})$/.exec(qp.value.trim());
      const extra = typed && !listed.has(Number(typed[1])) ? [{ label: `$(git-pull-request) #${typed[1]}`, description: 'open this pull request', alwaysShow: true, number: Number(typed[1]) }] : [];
      qp.items = [...extra, ...items];
    };
    update();
    qp.onDidChangeValue(update);
    const number = await new Promise((resolve) => {
      qp.onDidAccept(() => {
        const pick = qp.selectedItems[0];
        resolve(pick && pick.number);
        qp.hide();
      });
      qp.onDidHide(() => resolve(undefined));
      qp.show();
    });
    qp.dispose();
    return number;
  }

  /** Resolve {repo, remote, number, headSha, details} from a node or by asking. */
  async function resolvePr(arg) {
    if (arg && arg.number && arg.repoRoot) {
      const repo = manager.getRepository(arg.repoRoot);
      const details = await view.loadDetails(arg);
      return details && { repo, remote: arg.remote, number: arg.number, details };
    }
    const repo = await manager.pick(arg);
    if (!repo) return undefined;
    const remotes = await view.githubRemotes(repo);
    if (!remotes.length) {
      notify.warn('This repository has no remotes.');
      return undefined;
    }
    const remote = remotes.length === 1 ? remotes[0].name : (await vscode.window.showQuickPick(remotes.map((r) => r.name), { placeHolder: 'Remote' }));
    if (!remote) return undefined;
    const number = await pickPrNumber(repo, remote);
    if (!number) return undefined;
    const headSha = await withProgress(`Fetching pull request #${number}…`, (signal) => repo.fetchPullRequest(remote, number, { withMerge: true, signal, timeout: 120e3 }));
    const details = await view.computeDetails(repo, remote, number, headSha);
    view.refresh();
    return { repo, remote, number, details };
  }

  async function openChanges(pr) {
    const { details } = pr;
    await openMultiDiff(pr.repo, `PR #${pr.number} (${details.baseRef} … ${shortSha(details.headSha)})`, details.files.map((f) => ({
      path: f.path,
      leftRef: f.status === 'A' ? null : details.mergeBase,
      leftPath: f.origPath || f.path,
      rightRef: f.status === 'D' ? null : details.headSha,
    })));
  }

  cmd('commitCorner.prOpen', async (arg) => {
    const pr = await resolvePr(arg);
    if (pr) await openChanges(pr);
  });

  cmd('commitCorner.prChangeBase', async (arg) => {
    if (!arg || !arg.number) return;
    const repo = manager.getRepository(arg.repoRoot);
    const ref = await pickRef(repo, { placeHolder: `Base branch for #${arg.number}`, tags: false, extra: [{ label: '$(sync) Detect automatically', ref: '\0auto' }] });
    if (!ref) return;
    await ctx.extContext.workspaceState.update(view.baseKey(repo, arg.remote, arg.number), ref === '\0auto' ? undefined : ref);
    view.refresh(arg);
  });

  cmd('commitCorner.prCheckout', async (arg) => {
    const pr = await resolvePr(arg);
    if (!pr) return;
    const name = await inputBranchName('Local branch for this pull request', `pr/${pr.number}`);
    if (!name) return;
    const exists = await pr.repo.revParse(`refs/heads/${name}`);
    if (exists) {
      const choice = await notify.warn(`Branch "${name}" exists.`, { modal: true }, 'Reset It to the PR Head', 'Just Check It Out');
      if (!choice) return;
      if (!choice.startsWith('Reset')) {
        await ctx.checkoutWithStash(pr.repo, (force) => pr.repo.checkout(name, { force }));
        return;
      }
    }
    // Tracks the review ref, so Pull / Sync bring in commits pushed to the PR later.
    // A dirty working tree gets the same "Stash & Checkout" offer as any checkout.
    await ctx.checkoutWithStash(pr.repo, async (force) => {
      if (force) await pr.repo.run(['checkout', '-q', '--force', 'HEAD', '--']);
      await pr.repo.checkoutPullRequest(pr.remote, pr.number, name, pr.details.headSha);
    });
    vscode.window.setStatusBarMessage(`Checked out PR #${pr.number} as "${name}" (Pull updates it)`, 5000);
  });

  cmd('commitCorner.prCompare', async (arg) => {
    const pr = await resolvePr(arg);
    if (!pr) return;
    // Compare against the base commit itself: the branch name is only a label (it may be stale or unknown).
    const base = pr.details.baseTip || pr.details.mergeBase || pr.details.baseRef;
    await ctx.compare.setComparison(pr.repo, base, pr.details.headSha, 'threeDot', `PR #${pr.number} (${pr.details.baseRef})`);
  });

  // What the pull request does and what looks risky, by a language model.
  cmd('commitCorner.prSummarize', async (arg) => {
    const pr = await resolvePr(arg);
    if (!pr) return;
    const ai = require('../ai');
    await require('../webviews/summaryPanel').SummaryPanel.show(ctx, ai.pullRequestSource(pr.repo, pr.number, pr.details.mergeBase, pr.details.headSha));
  });

  cmd('commitCorner.prShowInGraph', async (arg) => {
    const pr = await resolvePr(arg);
    if (pr) await vscode.commands.executeCommand('commitCorner.showGraph', { repoRoot: pr.repo.root, revealSha: pr.details.headSha, includeRefs: [pr.repo.prRef(pr.remote, pr.number)] });
  });

  cmd('commitCorner.prOpenOnGitHub', async (arg) => {
    const repo = await manager.pick(arg);
    if (!repo || !arg || !arg.number) return;
    const remote = (await repo.getRemotes()).find((r) => r.name === arg.remote);
    const base = remote && githubWebUrl(remote.fetchUrl);
    if (base) await vscode.env.openExternal(vscode.Uri.parse(githubPullUrl(base, arg.number)));
    else notify.warn('This remote is not on github.com.');
  });

  cmd('commitCorner.prPruneRefs', async (arg) => {
    const repo = await manager.pick(arg);
    if (!repo) return;
    let removed = 0;
    for (const r of await view.githubRemotes(repo)) removed += await repo.pruneFetchedPullRequests(r.name);
    view.details.clear();
    view.refresh();
    notify.info(`Removed ${removed} fetched pull request ref(s). They are fetched again when you open a PR.`);
  });

  cmd('commitCorner.prCopyNumber', async (arg) => {
    if (arg && arg.number) await vscode.env.clipboard.writeText(`#${arg.number}`);
  });
}

module.exports = { PullRequestsView, register };
