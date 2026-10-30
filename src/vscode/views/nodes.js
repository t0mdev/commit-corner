'use strict';

const vscode = require('vscode');
const path = require('path');
const { EMPTY_TREE, WORKTREE } = require('../../git/repository');
const { shortSha, formatDate, tinyAge, absoluteDate, statusIcon, STATUS_LABELS, escapeMarkdown, config, commandLink, log } = require('../util');
const { avatarUri } = require('../avatars');
const viewed = require('../viewed');

/** Commands a commit tooltip may link to. */
const TOOLTIP_COMMANDS = ['commitCorner.showCommit', 'commitCorner.showGraph', 'commitCorner.copySha', 'commitCorner.openCommitOnGitHub', 'commitCorner.openPullRequestOnGitHub'];
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

class TreeProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    /** Bumped by a full refresh: stats still loading for the old rows are dropped. */
    this.statsEpoch = 0;
  }

  getTreeItem(node) {
    return node.getTreeItem();
  }

  async getChildren(node) {
    let children;
    try {
      if (node) children = node.getChildren ? await node.getChildren() : [];
      else children = await this.getRoots();
    } catch (e) {
      return [new MessageNode(`Error: ${e.message}`, 'error')];
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
        if (hit.size) this._onDidChangeTreeData.fire([...hit]);
      });
      this.settingSub = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('commitCorner.markUnviewedFiles')) this.refresh();
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
    if (counted.length) setTimeout(() => this._onDidChangeTreeData.fire([...new Set(counted)]), 0);
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
          if (changed.length) this._onDidChangeTreeData.fire(changed);
        }
      }
    };
    run().catch((e) => log().warn(`Tree stats: ${e.message}`));
  }

  getParent(node) {
    return node && node.parent;
  }

  refresh(node) {
    if (!node) {
      this.statsEpoch++;
      if (this.commitFiles) this.commitFiles.clear();
    }
    this._onDidChangeTreeData.fire(node);
  }

  dispose() {
    if (this.viewedSub) this.viewedSub.dispose();
    if (this.settingSub) this.settingSub.dispose();
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
      commandLink('$(diff-multiple) Show Changes', 'commitCorner.showCommit', node),
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
    item.contextValue = this.opts.contextValue || (this.opts.change ? 'commit:file' : 'commit');
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
      const { parent, files } = await this.repo.getCommitFiles(this.sha);
      this.files = files;
      this.children = fileNodes(this.repo, files, { leftRef: parent || EMPTY_TREE, rightRef: this.sha, sha: this.sha, parent: this, commitViewed: this.sha, contextValue: 'file:commit' });
    }
    return this.children;
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
  }

  /** The URIs its diff shows (to tell whether that diff is the editor you are looking at). */
  openUris() {
    const { uriAt } = require('../diffs');
    const leftRef = this.status === 'A' ? null : this.leftRef || EMPTY_TREE; // (this.parent is the tree node above, not a commit)
    // A commit's file opens tagged with its commit (Next Unviewed File knows where it is).
    const extra = this.commitViewed ? { commit: this.commitViewed } : undefined;
    return [uriAt(this.repo, leftRef, this.leftPath, extra), uriAt(this.repo, this.status === 'D' ? null : this.rightRef || this.sha, this.rightPath, extra)].map(String);
  }

  getTreeItem() {
    const name = path.posix.basename(this.path);
    const unviewed = !!this.commitViewed && viewed.commitFileUnviewed(this.commitViewed, this.change);
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
    const dir = path.posix.dirname(this.path);
    const stats = this.change.added !== undefined && this.change.added !== null ? `+${this.change.added} −${this.change.deleted}` : this.change.binary ? 'binary' : '';
    // In a folder tree the folder is the parent row; flat lists name it next to the file.
    item.description = [dir === '.' || this.inTree ? '' : dir, stats].filter(Boolean).join('  ');
    // The fragment keeps the file icon/theme but stops the working file's current
    // Explorer decorations (M, U, …) from showing on a historical entry.
    // A commit's file carries its viewed-mark key: not opened yet, it gets a dot (viewed.js).
    item.resourceUri = vscode.Uri.file(this.repo.absolute(this.path)).with({ fragment: 'commit-corner-history', query: this.commitViewed ? `vk=${viewed.ChangeMarks.key(this.commitViewed, this.change)}` : '' });
    item.iconPath = statusIcon(this.status);
    item.tooltip = `${STATUS_LABELS[this.status] || this.status}: ${this.origPath ? `${this.origPath} → ` : ''}${this.path}${unviewed ? '\n● Not viewed (the dot goes when you open it)' : ''}`;
    // A commit's file not viewed yet: its menu offers Mark as Viewed (else Mark as Not Viewed).
    item.contextValue = unviewed ? `${this.contextValue}:new` : this.contextValue;
    if (this.viewed) item.checkboxState = viewed.checkbox(viewed.get(), this.viewed.scope, this.path, this.viewed.fingerprint);
    item.command = {
      command: 'commitCorner.openCommitFile',
      title: 'Open Changes',
      // In a list you check off (Viewed), the keyboard stays in the list: Enter shows, Space ticks.
      arguments: [{ repoRoot: this.repoRoot, sha: this.sha, path: this.rightPath, origPath: this.leftPath, status: this.status, leftRef: this.leftRef, rightRef: this.rightRef, preserveFocus: !!this.viewed, viewedSha: this.commitViewed, oldBlob: this.change.oldBlob, newBlob: this.change.newBlob,
        title: this.diffLabel ? `${name} (${this.diffLabel}, ${(STATUS_LABELS[this.status] || 'changed').toLowerCase()})` : undefined }],
    };
    return item;
  }
}

/** Build FileNodes, optionally as a folder tree depending on settings. */
/**
 * @param {{tree?: boolean, viewed?: {scope: string, ids: Map<string, string>, owner?: any, provider?: any}}} [opts] tree: always
 *        a folder tree (pull requests), whatever the fileLayout setting says; viewed: a "Viewed"
 *        checkbox on each file (ids: the files' content fingerprints, see viewed.js; owner: the
 *        node redrawn when a mark changes)
 */
function fileNodes(repo, files, refs, opts = {}) {
  const nodes = files.map((f) => new FileNode(repo, f, refs));
  if (opts.viewed) for (const n of nodes) n.viewed = { scope: opts.viewed.scope, fingerprint: fingerprintOf(opts.viewed.ids, n), owner: opts.viewed.owner, provider: opts.viewed.provider };
  // A tree even for a single file: its folder is part of what you need to see.
  if (!opts.tree && config().get('fileLayout', 'tree') !== 'tree') return nodes;
  return buildFolderTree(nodes);
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
    item.contextValue = 'folder';
    return item;
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

module.exports = { TreeProvider, MessageNode, GroupNode, CommitNode, FileNode, FolderNode, TimeSeparatorNode, fileNodes, fingerprintOf, commitTooltip, withTimeSeparators, timeRangeOf };
