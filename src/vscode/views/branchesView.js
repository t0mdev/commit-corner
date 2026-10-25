'use strict';

const vscode = require('vscode');
const { TreeProvider, MessageNode, GroupNode, CommitNode } = require('./nodes');
const { formatDate, tinyAge, shortSha, config, debounce, escapeMarkdown } = require('../util');
const { stashGroup } = require('./stashesView');


/**
 * Repository view (id commitCorner.branches): outgoing/incoming commits, local
 * branches (with ahead/behind), remote branches grouped by remote, tags and
 * stashes. Each ref expands into its recent commits. (Worktrees have their own view.)
 */
class RefNode {
  constructor(repo, ref, current) {
    this.repo = repo;
    this.repoRoot = repo.root;
    this.refInfo = ref;
    // `rev` is what git gets: the full name when the short one could be read as an option.
    this.ref = ref.rev || ref.name;
    this.type = ref.type;
    this.sha = ref.sha;
    this.current = current;
    if (ref.type === 'remote') this.remote = ref.remote || ref.name.slice(0, ref.name.indexOf('/'));
  }

  getTreeItem() {
    const r = this.refInfo;
    const label = this.type === 'remote' ? r.name.slice(this.remote.length + 1) : r.name;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
    // Age first (when the branch last moved), then where it stands against its upstream.
    const parts = [config().get('dateFormat', 'relative') === 'relative' ? tinyAge(r.date).trim() : formatDate(r.date)];
    if (this.type === 'branch') {
      if (r.gone) parts.push('upstream gone');
      else if (r.upstream) {
        const ab = `${r.ahead ? `↑${r.ahead}` : ''}${r.behind ? `↓${r.behind}` : ''}`;
        parts.push(ab ? `${ab} ${r.upstream}` : r.upstream);
      }
    }
    item.description = parts.join(' • ');
    // Ref names and subjects come from other people: escape them.
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${escapeMarkdown(r.name)}** \`${shortSha(r.sha)}\`\n\n`);
    tip.appendText(r.subject || '');
    if (r.upstream) tip.appendMarkdown(`\n\nUpstream: ${escapeMarkdown(r.upstream)}${r.ahead || r.behind ? ` (${r.ahead} ahead, ${r.behind} behind)` : ''}`);
    item.tooltip = tip;
    const icon = this.type === 'tag' ? 'tag' : this.type === 'remote' ? 'cloud' : this.current ? 'check' : 'git-branch';
    item.iconPath = new vscode.ThemeIcon(icon, this.current ? new vscode.ThemeColor('gitDecoration.addedResourceForeground') : undefined);
    item.contextValue = this.type === 'branch' ? (this.current ? 'branch:current' : r.upstream ? 'branch:tracking' : 'branch') : this.type === 'remote' ? 'remoteBranch' : 'tag';
    item.id = `${this.repoRoot}:${r.fullName}`;
    return item;
  }

  async getChildren() {
    const commits = await this.repo.log({ revs: [this.refInfo.fullName], maxCount: config().get('branchCommitsLimit', 50) });
    return commits.map((c) => new CommitNode(this.repo, c, { parent: this }));
  }
}

class BranchesView extends TreeProvider {
  /** @param {import('../model').RepositoryManager} manager */
  constructor(manager) {
    super();
    this.manager = manager;
    this.view = require('../util').registerTreeView('commitCorner.branches', vscode.window.createTreeView('commitCorner.branches', { treeDataProvider: this, canSelectMany: true, showCollapseAll: true }));
    this.lastSignature = '';
    // Re-render only when refs actually changed, so file edits do not collapse the tree.
    const check = debounce(async () => {
      const repo = manager.active;
      if (!repo) return;
      try {
        // Ref tips alone (cheap): ahead/behind and upstreams only change when tips do.
        const s = repo.state;
        const sig = `${s && s.head.sha}|${s && s.head.branch}|${s && s.head.upstream}|${s && s.stashCount}|${repo.refTips !== undefined ? repo.refTips : await repo.getRefTips()}`;
        if (sig !== this.lastSignature) {
          this.lastSignature = sig;
          this.refresh();
        }
      } catch {
        // repository disappeared; the manager will close it
      }
    }, 400);
    this.disposables = [
      this.view,
      manager.onDidChangeActive(() => {
        this.lastSignature = '';
        this.refresh();
      }),
      manager.onDidChangeState((repo) => {
        if (repo === manager.active) check();
      }),
    ];
  }

  async getRoots() {
    const repo = this.manager.active;
    if (!repo) return []; // VS Code shows the welcome (Initialize / Clone / Open Repository)
    this.view.description = this.manager.repositories.length > 1 ? repo.name : undefined;
    const refs = await repo.getRefs();
    const headBranch = repo.state && repo.state.head.branch;
    const sortByName = config().get('branchSort', 'date') === 'name';
    const sort = (list) => (sortByName ? list.slice().sort((a, b) => a.name.localeCompare(b.name)) : list);
    const local = sort(refs.filter((r) => r.type === 'branch'));
    // Current branch always first.
    local.sort((a, b) => (b.name === headBranch) - (a.name === headBranch));
    const remotes = new Map();
    // Remote names may contain "/" ("team/a"): group by the longest remote name that matches.
    const remoteNames = [...new Set((await repo.getRemotes()).map((x) => x.name))].sort((a, b) => b.length - a.length);
    for (const r of sort(refs.filter((x) => x.type === 'remote'))) {
      const name = remoteNames.find((n) => r.name.startsWith(`${n}/`)) || r.name.slice(0, r.name.indexOf('/'));
      if (!remotes.has(name)) remotes.set(name, []);
      remotes.get(name).push({ ...r, remote: name });
    }
    const tags = refs.filter((r) => r.type === 'tag').sort((a, b) => b.date - a.date);
    const roots = [];
    if (!headBranch && repo.state && repo.state.head.sha) {
      roots.push(new MessageNode(`HEAD detached at ${shortSha(repo.state.head.sha)}`, 'debug-disconnect'));
    }
    // What a sync would push and pull, like IntelliJ's push dialog / incoming view.
    const head = repo.state && repo.state.head;
    if (head && head.branch && head.upstream && (head.ahead || head.behind)) {
      if (head.ahead) {
        roots.push(new GroupNode(`Outgoing (${head.ahead})`, async () => (await repo.log({ revs: ['HEAD', `^${head.upstream}`], topo: true, maxCount: 500 })).map((c) => new CommitNode(repo, c)), {
          icon: 'arrow-up', description: `to push to ${head.upstream}`, collapsed: head.ahead > 15, contextValue: 'group:outgoing', id: `${repo.root}:outgoing`,
        }));
      }
      if (head.behind) {
        roots.push(new GroupNode(`Incoming (${head.behind})`, async () => (await repo.log({ revs: [head.upstream, '^HEAD'], topo: true, maxCount: 500 })).map((c) => new CommitNode(repo, c)), {
          icon: 'arrow-down', description: `to pull from ${head.upstream}`, collapsed: head.behind > 15, contextValue: 'group:incoming', id: `${repo.root}:incoming`,
        }));
      }
    }
    roots.push(new GroupNode('Local', local.map((r) => new RefNode(repo, r, r.name === headBranch)), { icon: 'git-branch', description: String(local.length), contextValue: 'group:local', id: `${repo.root}:local` }));
    const remoteNodes = [...remotes.entries()].map(([name, list]) => new GroupNode(name, list.map((r) => new RefNode(repo, r, false)), {
      icon: 'cloud', description: String(list.length), contextValue: 'remote', collapsed: true, id: `${repo.root}:remote:${name}`, props: { remote: name, repoRoot: repo.root },
    }));
    if (remoteNodes.length) roots.push(new GroupNode('Remotes', remoteNodes, { icon: 'cloud', contextValue: 'group:remotes', id: `${repo.root}:remotes` }));
    if (tags.length) roots.push(new GroupNode('Tags', tags.map((r) => new RefNode(repo, r, false)), { icon: 'tag', description: String(tags.length), collapsed: true, contextValue: 'group:tags', id: `${repo.root}:tags` }));
    roots.push(stashGroup(repo));
    return roots;
  }

  dispose() {
    super.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

module.exports = { BranchesView, RefNode };
