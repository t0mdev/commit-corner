'use strict';

const vscode = require('vscode');
const path = require('path');
const { EMPTY_TREE, WORKTREE } = require('../../git/repository');
const { shortSha, formatDate, tinyAge, absoluteDate, statusIcon, STATUS_LABELS, escapeMarkdown, config, commandLink, log } = require('../util');
const { avatarUri } = require('../avatars');
const viewed = require('../viewed');
const merges = require('../merges');
/** ../diffs, loaded on first use (it loads this module's neighbours). */
let diffsModule;
const diffs = () => diffsModule || (diffsModule = require('../diffs'));

/** Commands a commit tooltip may link to. */
const TOOLTIP_COMMANDS = ['commitCorner.showCommit', 'commitCorner.showMergeResolution', 'commitCorner.showGraph', 'commitCorner.copySha', 'commitCorner.openCommitOnGitHub', 'commitCorner.openPullRequestOnGitHub'];
const { pullRequestOfSubject } = require('../../git/remoteUrl');

/** "+470 −39" or "" when unknown. */
function statsText(stats) {
  if (!stats) return '';
  if (!stats.files) return 'no changes';
  return `+${stats.added} −${stats.deleted}`;
}

/**
 * Tree node types shared by several views. Every node exposes the data
 * commands need (repoRoot, sha, ref, path, ...) as plain properties, because
 * VS Code passes the node itself as the command argument.
 */

/** A list with more files than this has its count redrawn once marking pauses. */
const BIG_LIST = 2000;
/** How long loading must have been quiet before rows are redrawn (TreeProvider.redraw)… */
const REDRAW_QUIET_MS = 300;
/** …and how long a row waits at most for other rows of its view (not for its own children). */
const REDRAW_MAX_HOLD_MS = 3000;
/** A clock that never goes back (the wall clock may, after a sleep or a time sync). */
const clock = () => performance.now();

class TreeProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    /** Bumped by a full refresh: stats still loading for the old rows are dropped. */
    this.statsEpoch = 0;
    /** getChildren calls still running, when the last one ended, and rows waiting to be redrawn (see redraw). */
    this.loading = 0;
    this.loadedAt = 0;
    /** row -> how many of its own getChildren calls are running */
    this.loadingRows = new Map();
    /** row -> since when it waits for its redraw (since its own children loaded, if they were loading) */
    this.pendingRedraw = new Map();
    this.redrawTimer = undefined;
    /** viewed scope -> the row that counts its marks ("2/5 viewed"; a list's files register it) */
    this.viewedOwners = new Map();
    // Redrawing that row reloads its files: for a list of thousands, once marking has paused
    // (stepping through files must not rebuild them all each time).
    this.ownerTimers = new Map();
    this.storeSub = viewed.get().onDidChange((scope) => {
      const owner = this.viewedOwners.get(scope);
      if (!owner) return;
      const size = Array.isArray(owner.viewedFiles) ? owner.viewedFiles.length : 0;
      if (size <= BIG_LIST) {
        this.redraw(owner);
        return;
      }
      clearTimeout(this.ownerTimers.get(scope));
      this.ownerTimers.set(scope, setTimeout(() => {
        this.ownerTimers.delete(scope);
        if (this.viewedOwners.get(scope) === owner) this.redraw(owner);
      }, 1500));
    });
    // The viewed dots switched on or off: rows with marks say so in their tooltips and menus too
    // (only they are redrawn: a full refresh would list pull requests again).
    this.settingSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('commitCorner.markUnviewedFiles')) return;
      const rows = [...(this.viewedOwners ? this.viewedOwners.values() : []), ...[...(this.commitFiles ? this.commitFiles.values() : [])].flatMap((m) => [...m.values()])];
      if (rows.length) this.redraw([...new Set(rows)]);
    });
  }

  getTreeItem(node) {
    return node.getTreeItem();
  }

  async getChildren(node) {
    let children;
    this.loading++;
    if (node) this.loadingRows.set(node, (this.loadingRows.get(node) || 0) + 1);
    try {
      if (node) children = node.getChildren ? await node.getChildren() : [];
      else children = await this.getRoots();
    } catch (e) {
      return [new MessageNode(`Error: ${e.message}`, 'error')];
    } finally {
      this.loading--;
      this.loadedAt = clock();
      if (node) {
        const left = this.loadingRows.get(node) - 1;
        if (left > 0) this.loadingRows.set(node, left);
        else {
          this.loadingRows.delete(node);
          // Its own children are there: from now on it waits like any other row.
          if (this.pendingRedraw.has(node)) this.pendingRedraw.set(node, this.loadedAt);
        }
      }
      if (this.pendingRedraw.size) this.scheduleRedraw();
    }
    this.fillStats(children || []);
    this.trackCommitFiles(children || []);
    return withTimeSeparators(children || []);
  }

  /**
   * Files of commits (not opened yet: a dot) and their commits ("3/12 viewed"): redrawn when a
   * mark changes, here or in the graph, or the setting does. One entry per commit file and per
   * commit (the newest node of each), dropped on a full refresh.
   */
  trackCommitFiles(nodes) {
    const files = [];
    const walk = (list) => {
      for (const n of list) {
        if (n instanceof FileNode && n.commitViewed) files.push(n);
        else if (n instanceof FolderNode) walk(n.children);
      }
    };
    walk(nodes);
    if (!files.length) return;
    if (!this.commitFiles) {
      /** mark key -> (node id -> node) */
      this.commitFiles = new Map();
      this.viewedSub = viewed.commitMarks().onDidChange((e) => {
        const hit = new Set();
        for (const k of e.keys) for (const n of (this.commitFiles.get(k) || new Map()).values()) hit.add(n);
        if (e.sha) for (const m of this.commitFiles.values()) for (const n of m.values()) if (n instanceof CommitNode && n.sha === e.sha) hit.add(n);
        if (hit.size) this.redraw([...hit]);
      });
    }
    const counted = [];
    for (const n of files) {
      const key = viewed.ChangeMarks.key(n.commitViewed, n.change);
      if (!this.commitFiles.has(key)) this.commitFiles.set(key, new Map());
      const m = this.commitFiles.get(key);
      m.set(`f:${n.commitViewed}:${n.path}`, n);
      const c = n.parent;
      if (c instanceof CommitNode) {
        // Its count needs the files it now knows: drawn again once (when any is viewed).
        if (!c.countShown && viewed.commitCount(c.sha, c.files || []).viewed) counted.push(c);
        c.countShown = true;
        m.set(c, c);
      }
    }
    if (counted.length) this.redraw([...new Set(counted)]);
  }

  /**
   * Change statistics of commit rows, loaded after the rows are shown: in small batches,
   * cached by the repository, and abandoned when the view refreshes. So long lists (500
   * outgoing commits, a big compare) appear at once and the numbers fill in.
   */
  fillStats(nodes) {
    if (!config().get('treeStats', true)) return;
    const pending = nodes.filter((n) => n instanceof CommitNode && !n.commit.stats);
    if (!pending.length) return;
    // File History rows count the lines of their file (under every name it had in the list).
    const filePaths = [...new Set(pending.flatMap((n) => (n.opts.change ? [n.opts.change.path, n.opts.change.origPath] : [])).filter(Boolean))];
    const groups = new Map();
    for (const n of pending) {
      const paths = n.opts.statsPaths || (n.opts.change ? filePaths : []);
      const key = paths.join('\0');
      if (!groups.has(key)) groups.set(key, { paths, nodes: [] });
      groups.get(key).nodes.push(n);
    }
    const epoch = this.statsEpoch;
    const run = async () => {
      for (const { paths, nodes: list } of groups.values()) {
        for (let i = 0; i < list.length; i += 40) {
          if (epoch !== this.statsEpoch) return;
          const batch = list.slice(i, i + 40);
          const stats = await batch[0].repo.commitStats(batch.map((n) => n.sha), { paths });
          if (epoch !== this.statsEpoch) return;
          const changed = batch.filter((n) => {
            const st = stats.get(n.sha);
            if (st) n.commit.stats = st;
            return !!st;
          });
          if (changed.length) this.redraw(changed);
        }
      }
    };
    run().catch((e) => log().warn(`Tree stats: ${e.message}`));
  }

  /** The row above (VS Code needs it to reveal a row): a file's folder, a list's row, … */
  getParent(node) {
    return node && (node.treeParent || node.parent);
  }

  refresh(node) {
    if (node) return this.redraw(node);
    this.statsEpoch++;
    if (this.commitFiles) this.commitFiles.clear();
    // The rows waiting for a redraw are about to be replaced; so are the rows that count viewed
    // marks (see the Pull Requests and Worktrees views: they register again as they load).
    this.pendingRedraw.clear();
    if (this.viewedOwners) this.viewedOwners.clear();
    clearTimeout(this.redrawTimer);
    this.redrawTimer = undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * Draw rows again (their children too), but not while VS Code is loading rows of this view: a
   * row redrawn while its children (or theirs) load ends up with only part of them, e.g. a large
   * pull request's files (until the next refresh). A row whose own children are loading waits
   * for them; then rows wait until loading has been quiet for 300 ms, at most 3 s (a slow load
   * elsewhere in the view, say another pull request being fetched, must not hold its counts).
   * @param {any|any[]} nodes
   */
  redraw(nodes) {
    const now = clock();
    for (const n of Array.isArray(nodes) ? nodes : [nodes]) if (n && !this.pendingRedraw.has(n)) this.pendingRedraw.set(n, now);
    this.scheduleRedraw();
  }

  scheduleRedraw() {
    clearTimeout(this.redrawTimer);
    this.redrawTimer = undefined;
    if (!this.pendingRedraw.size) return;
    const now = clock();
    const quietAt = this.loading ? Infinity : this.loadedAt + REDRAW_QUIET_MS;
    const ready = [];
    let next = Infinity;
    for (const [n, since] of this.pendingRedraw) {
      // Its own children are loading: the getChildren that ends schedules it again.
      if (this.loadingRows.has(n)) continue;
      const due = Math.min(quietAt, since + REDRAW_MAX_HOLD_MS);
      if (due <= now) ready.push(n);
      else next = Math.min(next, due);
    }
    for (const n of ready) this.pendingRedraw.delete(n);
    if (ready.length) this._onDidChangeTreeData.fire(ready);
    if (next !== Infinity) this.redrawTimer = setTimeout(() => this.scheduleRedraw(), Math.min(REDRAW_MAX_HOLD_MS, Math.max(1, next - now)));
  }

  dispose() {
    clearTimeout(this.redrawTimer);
    if (this.viewedSub) this.viewedSub.dispose();
    if (this.settingSub) this.settingSub.dispose();
    this.storeSub.dispose();
    for (const t of this.ownerTimers.values()) clearTimeout(t);
    this._onDidChangeTreeData.dispose();
  }
}

class MessageNode {
  constructor(message, icon, command) {
    this.message = message;
    this.icon = icon;
    this.command = command;
  }

  getTreeItem() {
    const item = new vscode.TreeItem(this.message, vscode.TreeItemCollapsibleState.None);
    if (this.icon) item.iconPath = new vscode.ThemeIcon(this.icon);
    if (this.command) item.command = this.command;
    item.contextValue = 'message';
    return item;
  }
}

/** The time ranges of commit lists, newest first (same as the sidebar Graph). */
const TIME_RANGES = ['Today', 'Yesterday', 'This week', 'This month', 'Older'];

function timeRangeOf(ms, now = new Date()) {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= day) return 0;
  if (ms >= day - 864e5) return 1;
  if (ms >= day - 6 * 864e5) return 2;
  if (ms >= day - 29 * 864e5) return 3;
  return 4;
}

/** A "Today" / "This week" / … line between commits of a timeline. */
class TimeSeparatorNode {
  constructor(label, count, noun = 'commit') {
    this.label = label;
    this.count = count;
    this.noun = noun;
  }

  getTreeItem() {
    const item = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.None);
    item.description = `${this.count} ${this.noun}${this.count === 1 ? '' : 's'}`;
    item.iconPath = new vscode.ThemeIcon('calendar');
    item.contextValue = 'timeSeparator';
    item.accessibilityInformation = { label: `${this.label}: ${item.description}`, role: 'separator' };
    return item;
  }
}

/**
 * Commit lists (two or more commits) get a separator line wherever the time range changes:
 * Today, Yesterday, This week, This month, Older. A range can repeat when the list is not
 * strictly by date (e.g. history of a file across merged branches).
 */
function withTimeSeparators(nodes) {
  if (!config().get('timeSeparators', true)) return nodes;
  // Timeline items: commits (by author date) and anything else with a `timelineDate` (pull requests).
  const dated = nodes.filter((n) => typeof n.timelineDate === 'number' && n.timelineDate > 0);
  if (dated.length < 2) return nodes;
  const out = [];
  let current = -1;
  let separator;
  for (const n of nodes) {
    if (typeof n.timelineDate === 'number' && n.timelineDate > 0) {
      const range = timeRangeOf(n.timelineDate);
      if (range !== current) {
        separator = new TimeSeparatorNode(TIME_RANGES[range], 0, n.timelineNoun || 'commit');
        out.push(separator);
        current = range;
      }
      separator.count++;
    }
    out.push(n);
  }
  return out;
}

/** A folder grouping (e.g. "Local", "Remotes", "Files (12)"). */
class GroupNode {
  constructor(label, children, opts = {}) {
    this.label = label;
    this.childNodes = children;
    this.opts = opts;
    Object.assign(this, opts.props || {});
  }

  getTreeItem() {
    const state = this.opts.collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded;
    const item = new vscode.TreeItem(this.label, state);
    if (this.opts.icon) item.iconPath = new vscode.ThemeIcon(this.opts.icon);
    // A function: worked out at each redraw (a count that changes, "3 of 12 viewed").
    if (this.opts.description) item.description = typeof this.opts.description === 'function' ? this.opts.description() : this.opts.description;
    if (this.opts.tooltip) item.tooltip = this.opts.tooltip;
    item.contextValue = this.opts.contextValue || 'group';
    if (this.opts.id) item.id = this.opts.id;
    return item;
  }

  async getChildren() {
    return typeof this.childNodes === 'function' ? this.childNodes() : this.childNodes;
  }
}

/**
 * Rich commit tooltip: author, when, SHA, change statistics, refs, the message, and links.
 * @param {import('../../git/parse').Commit & {stats?: {files:number, added:number, deleted:number}}} c
 * @param {string} [repoRoot] enables the action links
 */
function commitTooltip(c, repoRoot) {
  const md = new vscode.MarkdownString(undefined, true);
  md.supportThemeIcons = true;
  md.appendMarkdown(`$(person) **${escapeMarkdown(c.authorName)}** ${escapeMarkdown(c.authorEmail ? `<${c.authorEmail}>` : '')}  \n`);
  md.appendMarkdown(`$(clock) ${escapeMarkdown(formatDate(c.authorDate))} (${escapeMarkdown(absoluteDate(c.authorDate))})  \n`);
  if (c.commitDate && Math.abs(c.commitDate - c.authorDate) > 36e5) {
    md.appendMarkdown(`$(history) committed ${escapeMarkdown(formatDate(c.commitDate))}${c.committerName && c.committerName !== c.authorName ? ` by ${escapeMarkdown(c.committerName)}` : ''}  \n`);
  }
  let line = `$(git-commit) \`${shortSha(c.sha)}\``;
  if (c.parents && c.parents.length > 1) line += ' $(git-merge) merge commit';
  if (c.stats && c.stats.files) {
    line += ` · $(diff) ${c.stats.files} file${c.stats.files === 1 ? '' : 's'} changed, **+${c.stats.added}** **−${c.stats.deleted}**`;
  }
  md.appendMarkdown(`${line}\n\n`);
  const icon = { branch: 'git-branch', remote: 'cloud', tag: 'tag' };
  const refs = (c.refs || []).filter((r) => r.type !== 'head');
  if (refs.length) md.appendMarkdown(`${refs.map((r) => `$(${icon[r.type] || 'git-commit'}) ${escapeMarkdown(r.name)}`).join(' · ')}\n\n`);
  md.appendMarkdown('---\n\n');
  // This tooltip may run (allowlisted) commands, so the message is escaped completely —
  // including "<", which appendText leaves alone (an autolink like <command:…> would be live).
  md.appendMarkdown(escapeMarkdown(c.body || c.subject).replace(/\n/g, '  \n'));
  if (repoRoot) {
    md.isTrusted = { enabledCommands: TOOLTIP_COMMANDS };
    const node = { repoRoot, sha: c.sha };
    md.appendMarkdown(`\n\n---\n\n${[
      // A merge: Show Changes asks which of its views; its resolution is one click away too.
      ...(c.parents && c.parents.length > 1
        ? [commandLink('$(diff-multiple) Show Changes…', 'commitCorner.showCommit', node), ...(c.parents.length === 2 ? [commandLink('$(git-compare) Merge Resolution', 'commitCorner.showMergeResolution', node)] : [])]
        : [commandLink('$(diff-multiple) Show Changes', 'commitCorner.showCommit', node)]),
      commandLink('$(git-merge) Show in Graph', 'commitCorner.showGraph', { repoRoot, revealSha: c.sha }),
      commandLink('$(copy) Copy SHA', 'commitCorner.copySha', node),
      commandLink('$(github) Open on GitHub', 'commitCorner.openCommitOnGitHub', node),
      ...(pullRequestOfSubject(c.subject) ? [commandLink(`$(git-pull-request) Pull request #${pullRequestOfSubject(c.subject)}`, 'commitCorner.openPullRequestOnGitHub', { repoRoot, number: pullRequestOfSubject(c.subject) })] : []),
    ].join(' &nbsp;·&nbsp; ')}`);
  }
  return md;
}

/** A commit; expands to the files it changed. */
class CommitNode {
  /**
   * @param {import('../../git/repository').Repository} repo
   * @param {import('../../git/parse').Commit} commit
   * @param {{filePath?:string, change?:object, contextValue?:string, description?:string, parent?:any}} [opts]
   */
  constructor(repo, commit, opts = {}) {
    this.repo = repo;
    this.repoRoot = repo.root;
    this.commit = commit;
    this.sha = commit.sha;
    this.opts = opts;
    /** Where the commit sits in time-separated lists: its commit date, like the lists' order. */
    this.timelineDate = commit.commitDate || commit.authorDate;
    this.parent = opts.parent;
    // When shown in a file's history, clicking opens that file's diff.
    if (opts.change) {
      this.path = opts.change.path;
      this.origPath = opts.change.origPath;
      this.status = opts.change.status;
      this.currentPath = opts.currentPath;
    }
  }

  getTreeItem() {
    const c = this.commit;
    const collapsible = this.opts.change ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed;
    // When first (a fixed-width age at the start of every label, so it lines up), who as the
    // avatar icon, what as the subject; size and author follow in the description.
    // Relative ages by default; the dateFormat setting switches the column to dates.
    // Committed (the order of these lists, and what a rebase or an agent's amend updates).
    const when = c.commitDate || c.authorDate;
    const age = config().get('dateFormat', 'relative') === 'relative' ? tinyAge(when) : formatDate(when);
    const item = new vscode.TreeItem(`${age}  ${c.subject || '(no message)'}`, collapsible);
    const parts = [];
    // Once its files are listed and one was opened: how many of them you have seen (first, so
    // a narrow sidebar does not cut it off).
    if (this.files && viewed.marksUnviewed()) {
      const n = viewed.commitCount(this.sha, this.files);
      if (n.viewed) parts.push(n.viewed === n.total ? '✓ viewed' : `${n.viewed}/${n.total} viewed`);
    }
    const stats = statsText(c.stats);
    if (stats) parts.push(stats);
    // The avatar replaces the commit/merge icon, so a merge says so in words.
    if (c.parents.length > 1) parts.push('merge');
    if (config().get('showAuthorInLists', true)) parts.push(c.authorName);
    item.description = this.opts.description || parts.join(' • ');
    item.tooltip = commitTooltip(c, this.repoRoot);
    // Screen readers: the message first, then when, who and how much, in words.
    item.accessibilityInformation = {
      label: `${c.subject || 'no message'}, ${formatDate(c.authorDate)} by ${c.authorName}${c.stats && c.stats.files ? `, ${c.stats.files} file${c.stats.files === 1 ? '' : 's'}, ${c.stats.added} added, ${c.stats.deleted} deleted` : ''}${c.parents.length > 1 ? ', merge commit' : ''}`,
    };
    item.iconPath = avatarUri(c.authorName, c.authorEmail) || new vscode.ThemeIcon(c.parents.length > 1 ? 'git-merge' : 'git-commit');
    item.contextValue = this.opts.contextValue || (this.opts.change ? 'commit:file' : c.parents.length > 2 ? 'commit:octopus' : c.parents.length === 2 ? 'commit:merge' : 'commit');
    if (this.opts.change) {
      const ch = this.opts.change;
      item.command = {
        command: 'commitCorner.openCommitFile',
        title: 'Open Changes',
        arguments: [{ repoRoot: this.repoRoot, sha: c.sha, parent: c.parents[0] || EMPTY_TREE, path: ch.path, origPath: ch.origPath, status: ch.status, title: `${path.posix.basename(ch.path)} (${shortSha(c.sha)}) ${c.subject}`, viewedSha: c.sha }],
      };
    }
    return item;
  }

  async getChildren() {
    // Kept: a viewed mark redraws this row (its count), which asks for the files again.
    if (!this.children) {
      const { parent, files } = await this.repo.getCommitFiles(this.sha, this.commit);
      // (A merge's viewed count, like the graph's, is of its first-parent changes.)
      this.files = files;
      if (this.commit.parents.length > 1) {
        // A merge's sections, each drawn once in its state: what git finds is worked out here
        // (this row shows progress meanwhile; the resolution is shared and kept, counts too, so
        // closing the row early wastes nothing: the next look takes it; git < 2.38 refuses the
        // merges that would take long, see resolveMergeTree).
        const sides = await merges.parentSides(this.repo, this.commit);
        const sections = merges.mergeViews(this.commit).map((view) => new MergeViewNode(this, view, view === 'parent1' ? files : undefined, sides));
        await Promise.all(sections.map((x) => x.prepare()));
        this.children = sections;
      } else this.children = fileNodes(this.repo, files, { leftRef: parent || EMPTY_TREE, rightRef: this.sha, sha: this.sha, parent: this, commitViewed: this.sha, contextValue: 'file:commit' });
    }
    return this.children;
  }
}

/**
 * One view of a merge commit (merges.js) under its row: Merge Resolution (open), Changes vs
 * Parent 1 and 2 (closed until you open them; Parent 1 open for a clean merge). Its files open
 * against that view's side.
 */
class MergeViewNode {
  /** @param {CommitNode} commitNode @param {string} view @param {object[]} [files] already known @param {string[]} [sides] merges.parentSides */
  constructor(commitNode, view, files, sides = []) {
    this.sides = sides;
    this.repo = commitNode.repo;
    this.repoRoot = commitNode.repoRoot;
    this.commit = commitNode.commit;
    this.sha = commitNode.sha;
    this.view = view;
    this.parent = commitNode;
    this.files = files;
    this.result = undefined;
  }

  /** The view's files (once): {files, left, leftLabel, exact} or {error}. */
  load() {
    if (!this.result && this.view === 'parent1' && this.files) this.result = { files: this.files, left: this.commit.parents[0] };
    if (this.result) return Promise.resolve(this.result);
    if (!this.loading) {
      this.loading = merges.mergeViewFiles(this.repo, this.commit, this.view).catch((e) => {
        log().warn(`Merge ${shortSha(this.sha)}, ${this.view}: ${e.message}`);
        return { error: e.message };
      }).then((r) => {
        this.result = r;
        return r;
      });
    }
    return this.loading;
  }

  /** Before the row is drawn: the resolution's files, or a closed section's count. */
  async prepare() {
    if (this.view === 'resolution' || this.files) await this.load();
    else {
      this.count = await merges.countView(this.repo, this.commit, this.view).then((c) => c.count, (e) => {
        log().warn(`Merge ${shortSha(this.sha)}, ${this.view}: ${e.message}`);
        this.countError = e.message;
        return null;
      });
    }
  }

  getTreeItem() {
    const resolution = this.view === 'resolution';
    const r = this.result;
    const n = r && r.files ? r.files.length : typeof this.count === 'number' ? this.count : undefined;
    // Open: the resolution, or for a clean merge (nothing to resolve, or no resolution to have)
    // what it brought in.
    let open = resolution;
    if (this.view === 'parent1') {
      const res = this.parent.children && this.parent.children.find((x) => x.view === 'resolution');
      open = !res || !!(res.result && (res.result.error || !res.result.files.length));
    }
    const error = (r && r.error) || this.countError;
    const state = error || n === 0 ? vscode.TreeItemCollapsibleState.None : open ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
    const item = new vscode.TreeItem(merges.viewTitle(this.view), state);
    const side = resolution ? '' : `${shortSha(this.commit.parents[Number(this.view.slice(6)) - 1])} · `;
    item.description = error ? `${side}unavailable` : `${side}${merges.countText(this.view, n || 0, r && r.exact)}`;
    item.tooltip = `${merges.viewDetail(this.commit, this.view, this.sides)}${r && r.exact === false ? `\n(${merges.APPROXIMATE})` : ''}${error ? `\n\nUnavailable: ${error}` : ''}`;
    item.iconPath = new vscode.ThemeIcon(resolution ? 'git-compare' : 'diff');
    item.contextValue = n ? 'mergeView' : 'mergeView:empty';
    return item;
  }

  async getChildren() {
    const r = await this.load();
    if (!r.files) return [];
    this.files = r.files;
    return fileNodes(this.repo, r.files, {
      leftRef: r.left, rightRef: this.sha, sha: this.sha, parent: this, commitViewed: this.sha, contextValue: 'file:commit',
      ...(this.view === 'parent1' ? {} : { base: r.left }), ...(r.leftLabel ? { leftLabel: r.leftLabel } : {}),
    });
  }
}

/** A changed file between two refs. Clicking opens the diff. */
class FileNode {
  /**
   * @param {{status:string, path:string, origPath?:string, added?:number|null, deleted?:number|null}} change
   * @param {{leftRef:string|null, rightRef:string|null, sha?:string, contextValue?:string, leftPath?:string, rightPath?:string, parent?:any}} refs
   */
  constructor(repo, change, refs) {
    this.repo = repo;
    this.repoRoot = repo.root;
    this.change = change;
    this.path = change.path;
    this.origPath = change.origPath;
    this.status = change.status;
    this.leftRef = change.status === 'A' ? null : refs.leftRef;
    this.rightRef = change.status === 'D' ? null : refs.rightRef;
    this.leftPath = refs.leftPath || change.origPath || change.path;
    this.rightPath = refs.rightPath || change.path;
    // `sha` is the revision of the right side when it is a real revision (not the working tree).
    this.sha = refs.sha || (refs.rightRef && refs.rightRef !== WORKTREE ? refs.rightRef : undefined);
    this.contextValue = refs.contextValue || (this.sha && this.rightRef !== null ? 'file' : 'file:other');
    this.parent = refs.parent;
    /** What its diff tab says it is from ("#21"); otherwise the two revisions. */
    this.diffLabel = refs.diffLabel;
    /** A file of this commit: bold until you open it (see viewed.commitFileUnviewed). */
    this.commitViewed = refs.commitViewed;
    /** A merge's resolution or other parent: the left side when it is not the first parent. */
    this.base = refs.base;
    this.leftLabel = refs.leftLabel;
  }

  /**
   * Show its diff as its row's click does (and so mark it viewed, in a list with marks).
   * @param {{preserveFocus?: boolean}} [o] preserveFocus false: the keyboard goes to the diff
   *        (Next Unviewed File, pressed in the diff before)
   */
  async open(o = {}) {
    const { command, arguments: [args] } = this.getTreeItem().command;
    await vscode.commands.executeCommand(command, o.preserveFocus === undefined ? args : { ...args, preserveFocus: o.preserveFocus });
  }

  /** Not opened yet (its dot): a commit's file, or one of a list with marks (this.viewed). */
  unviewed() {
    return this.viewed ? viewed.scopedUnviewed(this.viewed.scope, this.path, this.viewed.fingerprint) : !!this.commitViewed && viewed.commitFileUnviewed(this.commitViewed, this.change);
  }

  /** What its viewed mark changes with (to redraw only the dots that change): see viewed.folderKey. */
  markId() {
    if (this.viewed) return `s\0${this.viewed.scope}\0${this.path}`;
    return this.commitViewed ? `k\0${viewed.ChangeMarks.key(this.commitViewed, this.change)}` : undefined;
  }

  /** The URIs its diff shows (to tell whether that diff is the editor you are looking at). */
  openUris() {
    const { uriAt } = diffs();
    const leftRef = this.status === 'A' ? null : this.leftRef || EMPTY_TREE; // (this.parent is the tree node above, not a commit)
    // A commit's file opens tagged with its commit (Next Unviewed File knows where it is).
    const extra = this.commitViewed ? { commit: this.commitViewed, ...(this.base ? { base: this.base } : {}) } : undefined;
    const leftExtra = this.leftLabel ? { ...extra, label: this.leftLabel } : extra;
    return [uriAt(this.repo, leftRef, this.leftPath, leftExtra), uriAt(this.repo, this.status === 'D' ? null : this.rightRef || this.sha, this.rightPath, extra)].map(String);
  }

  /**
   * The one side of its diff that is this row's alone: the new version (the old one, for a
   * deletion). Two pull requests from the same base share the old side of a file both change.
   */
  ownUri() {
    const [left, right] = this.openUris();
    return this.status === 'D' ? left : right;
  }

  /** The other side of its diff, when it shows both (Next Unviewed File checks it too). */
  leftUri() {
    return this.status === 'A' || this.status === 'D' ? undefined : this.openUris()[0];
  }

  getTreeItem() {
    const name = path.posix.basename(this.path);
    // Not opened yet (a dot): a commit's file, or one of a pull request's files (this.viewed).
    const unviewed = this.unviewed();
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
    const dir = path.posix.dirname(this.path);
    const stats = this.change.added !== undefined && this.change.added !== null ? `+${this.change.added} −${this.change.deleted}` : this.change.binary ? 'binary' : '';
    // In a folder tree the folder is the parent row; flat lists name it next to the file.
    // In a merge resolution: git's merge had a conflict here (else the merge edited it).
    item.description = [dir === '.' || this.inTree ? '' : dir, stats, this.change.conflict ? 'conflict' : ''].filter(Boolean).join('  ');
    // The fragment keeps the file icon/theme but stops the working file's current
    // Explorer decorations (M, U, …) from showing on a historical entry.
    // A commit's file carries its viewed-mark key: not opened yet, it gets a dot (viewed.js).
    const mark = this.viewed ? `vs=${viewed.scopedKey(this.viewed.scope, this.path, this.viewed.fingerprint)}` : this.commitViewed ? `vk=${viewed.ChangeMarks.key(this.commitViewed, this.change)}` : '';
    item.resourceUri = vscode.Uri.file(this.repo.absolute(this.path)).with({ fragment: 'commit-corner-history', query: mark });
    item.iconPath = statusIcon(this.status);
    const why = this.change.conflict ? '\ngit\'s automatic merge left conflict markers here (left side); the right side is how the merge resolved them' : this.leftLabel ? '\nEdited in the merge beyond git\'s automatic merge' : '';
    const markLine = this.viewed ? `\n${viewed.scopedTooltip(this.viewed.scope, this.path, this.viewed.fingerprint)}` : unviewed ? '\n● Not viewed (the dot goes when you open it)' : '';
    item.tooltip = `${STATUS_LABELS[this.status] || this.status}: ${this.origPath ? `${this.origPath} → ` : ''}${this.path}${why}${markLine}`;
    // Not viewed yet: its menu offers Mark as Viewed (else Mark as Not Viewed). A pull request's
    // file offers them whatever the dots setting says, one that cannot be fingerprinted (a
    // symlink, a submodule) neither.
    const state = this.viewed ? viewed.scopedState(this.viewed.scope, this.path, this.viewed.fingerprint) : unviewed ? 'new' : 'none';
    item.contextValue = state === 'none' ? this.contextValue : `${this.contextValue}:${state}`;
    // A row of a list with marks keeps its identity when the list is drawn again (revealing it after
    // Next Unviewed File then finds this very file, not another of the same name).
    if (this.viewed) item.id = `viewed\0${this.viewed.scope}\0${this.path}`;
    item.command = {
      command: 'commitCorner.openCommitFile',
      title: 'Open Changes',
      // A pull request's files: the keyboard stays in the list (Enter shows a file, ↓ the next);
      // opening one marks it viewed (scope and fingerprint: `viewed`).
      arguments: [{ repoRoot: this.repoRoot, sha: this.sha, path: this.rightPath, origPath: this.leftPath, status: this.status, leftRef: this.leftRef, rightRef: this.rightRef, preserveFocus: !!this.viewed, viewedSha: this.commitViewed, oldBlob: this.change.oldBlob, newBlob: this.change.newBlob, base: this.base, leftLabel: this.leftLabel,
        viewed: this.viewed ? { scope: this.viewed.scope, fingerprint: this.viewed.fingerprint, path: this.path } : undefined,
        title: this.diffLabel ? `${name} (${this.diffLabel}, ${(STATUS_LABELS[this.status] || 'changed').toLowerCase()})` : undefined }],
    };
    return item;
  }
}

/**
 * Build FileNodes, optionally as a folder tree depending on settings.
 * @param {{tree?: boolean, viewed?: {scope: string, ids: Map<string, string>, owner?: any, provider?: any, label?: string}}} [opts] tree: always
 *        a folder tree (pull requests), whatever the fileLayout setting says; viewed: "Viewed"
 *        marks on the files, a dot until opened (ids: the files' content fingerprints, see
 *        viewed.js; owner: the node redrawn when a mark changes; label: what Next Unviewed File
 *        calls the list, "pull request #7")
 */
function fileNodes(repo, files, refs, opts = {}) {
  const nodes = files.map((f) => new FileNode(repo, f, refs));
  if (opts.viewed) for (const n of nodes) n.viewed = { scope: opts.viewed.scope, fingerprint: fingerprintOf(opts.viewed.ids, n), owner: opts.viewed.owner, provider: opts.viewed.provider };
  // A tree even for a single file: its folder is part of what you need to see.
  const out = !opts.tree && config().get('fileLayout', 'tree') !== 'tree' ? nodes : buildFolderTree(nodes);
  // Each row knows the row it is under (getParent), so a file can be revealed in the tree.
  // (And the rows next to it: Collapse This Level collapses a folder's siblings too.)
  const link = (list, up) => {
    for (const n of list) {
      n.siblings = list;
      if (up) n.treeParent = up;
      if (n instanceof FolderNode) link(n.children, n);
    }
  };
  link(out, (opts.viewed && opts.viewed.owner) || refs.parent);
  markFolders(out);
  if (opts.viewed) {
    // Folders get Mark as Viewed / Not Viewed for their files; Next Unviewed File in the diffs
    // goes through the files in the order shown.
    const shown = [];
    const walk = (list) => {
      for (const n of list) {
        if (n instanceof FolderNode) {
          n.marks = true;
          walk(n.children);
        } else shown.push(n);
      }
    };
    walk(out);
    if (opts.viewed.label) viewed.registerList(opts.viewed.scope, opts.viewed.label, shown);
  }
  return out;
}

/** Folders with more files than this below them (or deeper than this) get no dot. */
const MAX_FOLDER_FILES = 5000;
const MAX_FOLDER_DEPTH = 64;

/**
 * The files with viewed marks in each folder and below (`markFiles`) and the folder's key for its
 * dot (`marksId`: its list, path and a digest of those files' marks and contents, so a file that
 * changes gives the folder a new key), worked out once, bottom-up, when the tree is built.
 * Returns the files of `list` and below, or undefined past the limits.
 */
function markFolders(list, depth = 0) {
  let all = [];
  for (const n of list) {
    if (n instanceof FolderNode) {
      const below = depth >= MAX_FOLDER_DEPTH ? undefined : markFolders(n.children, depth + 1);
      if (below && below.length) setFolderMarks(n, below);
      if (!below || !all || all.length + below.length > MAX_FOLDER_FILES) all = undefined;
      else all = all.concat(below);
    } else if (all && n.markId && n.markId()) {
      all.push(n);
      if (all.length > MAX_FOLDER_FILES) all = undefined;
    }
  }
  return all;
}

function setFolderMarks(folder, files) {
  const first = files[0];
  if (!first.repo) return;
  const digest = require('crypto').createHash('sha1');
  for (const f of files) digest.update(`${f.markId()}\0${f.viewed ? f.viewed.fingerprint || '' : ''}\n`);
  folder.markFiles = files;
  folder.marksId = `${first.viewed ? first.viewed.scope : first.commitViewed}\0${folder.fullPath}\0${digest.digest('hex')}`;
}

class FolderNode {
  constructor(name, fullPath) {
    this.name = name;
    this.fullPath = fullPath;
    this.children = [];
  }

  getTreeItem() {
    const item = new vscode.TreeItem(this.name, vscode.TreeItemCollapsibleState.Expanded);
    item.iconPath = vscode.ThemeIcon.Folder;
    // In a list with viewed marks (a pull request's files): Mark as Viewed / Not Viewed for all in it.
    item.contextValue = this.marks ? 'folder:marks' : 'folder';
    // A dot while a file in it (or below) has not been opened, so a collapsed folder says so too
    // (its files and their key are worked out once, when the tree is built: see markFolders).
    if (this.markFiles && this.marksId) {
      const key = viewed.folderKey(this.markFiles, this.marksId);
      item.resourceUri = vscode.Uri.file(this.markFiles[0].repo.absolute(this.fullPath)).with({ fragment: 'commit-corner-history', query: `vf=${key}` });
    }
    return item;
  }

  /** The files in it and its sub-folders. */
  files() {
    return this.children.flatMap((c) => (c instanceof FolderNode ? c.files() : [c]));
  }

  getChildren() {
    return this.children;
  }
}

/** A file's fingerprint for "viewed": its blob id there, or "deleted" (a deletion stays seen). */
function fingerprintOf(ids, change) {
  return ids.get(change.path) || (change.status === 'D' ? 'deleted' : undefined);
}

/** Group file nodes into folders, compacting single-child folder chains ("src/vscode"). */
function buildFolderTree(nodes) {
  const root = new FolderNode('', '');
  // Sub-folders by name (a linear search per file is quadratic with thousands of files).
  const subs = new Map();
  for (const n of nodes) {
    const parts = n.path.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts.slice(0, i + 1).join('/');
      let next = subs.get(key);
      if (!next) {
        next = new FolderNode(parts[i], key);
        subs.set(key, next);
        cur.children.push(next);
      }
      cur = next;
    }
    cur.children.push(n);
    n.inTree = true;
  }
  const compact = (folder) => {
    folder.children = folder.children.map((c) => {
      if (!(c instanceof FolderNode)) return c;
      let f = c;
      while (f.children.length === 1 && f.children[0] instanceof FolderNode) {
        const only = f.children[0];
        only.name = `${f.name}/${only.name}`;
        f = only;
      }
      compact(f);
      return f;
    });
    folder.children.sort((a, b) => {
      const af = a instanceof FolderNode ? 0 : 1;
      const bf = b instanceof FolderNode ? 0 : 1;
      if (af !== bf) return af - bf;
      return (a.name || path.posix.basename(a.path)).localeCompare(b.name || path.posix.basename(b.path));
    });
  };
  compact(root);
  return root.children;
}

module.exports = { TreeProvider, MessageNode, GroupNode, CommitNode, MergeViewNode, FileNode, FolderNode, TimeSeparatorNode, fileNodes, fingerprintOf, commitTooltip, withTimeSeparators, timeRangeOf };
