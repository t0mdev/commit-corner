# Changelog

## 1.0.0

First public release.

- **Sidebar** with six views, one at a time: Graph (with the full staging area and commit box), Repository (outgoing, branches, remotes, tags, stashes), Pull Requests, Compare, File History and Worktrees.
- **Commit graph** in an editor: branches, tags and remotes as badges, commit details, filters and search, checkout, branch, cherry-pick, revert, reset and interactive rebase from the graph.
- **Worktree review**: an agent's worktree expands to *Changes vs main*, file by file, with *Viewed* checkboxes that untick when the file changes again.
- **Pull requests (GitHub.com)**: commits and files changed with *Viewed* checkboxes, diffs against the merge base, optional details from the GitHub API (title, author, state, reviews, checks).
- **Source Control**: line and hunk staging, amend, undo last commit, stashes, protected branches, generated commit messages (✨).
- **Summaries** of a worktree, pull request or selected commits through VS Code's Language Model API: what changed, what looks risky, what to review first.
- **History and blame**: File History, inline blame for the current line, compare any two refs, bisect, patches.
- **Repository Activity**: commits per day, people, busiest files, merged pull requests and active branches.
- **Keyboard first**: the Actions hub (`Ctrl+Alt+G Space`) and `Ctrl+Alt+G` chords for the main views; `?` in the graph lists its keys.
- Plain JavaScript, no runtime dependencies, no telemetry.
