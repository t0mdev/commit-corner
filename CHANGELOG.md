# Changelog

## Unreleased

- **Fixed:** summaries and generated commit messages came back empty when `commitCorner.ai.modelFamily` named a model that Copilot CLI lists too (Copilot CLI's models answer other extensions with nothing). They are skipped now, and Copilot's model is used when several providers offer the same one.
- `commitCorner.ai.modelFamily` also takes a model's id, its name, or provider/id (one model that several providers offer); **Choose Language Model…** lists the models that answer, stores your choice and asks again on the summary page.
- An empty answer is an error that says what came instead (a tool call, thinking…), with *Choose Model…* and *Show Log*, on the summary page and in the notification. Model refusals of any kind offer another model. The page names the model while it asks, and says when the model from the setting is not available (✨ says it once per session).
- Stop is never reported as an error, also while the changes are read or before the model answers.
- Output → Commit Corner starts with the Commit Corner, VS Code and OS versions, and follows every language model request: the model providers' versions, the model chosen, what was sent, how the answer came (time to the first part, a line every 30 s while a model is silent), errors with their code or git's command and words, each logged once; the answer at log level Debug, the request at Trace. Script errors of the summary page are logged too.
- "Show Git Output" is now "Show Log".

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
