# Changelog

## 1.2.0

- **Open the working file from any file row** (graph, details pane, Repository, Compare, Pull Requests, File History): `O` or the new file button, at the line you were looking at in that revision's diff (mapped through the edits since), under its new name when it was renamed. *Open Working File* (`Ctrl+Alt+G Shift+W`) is also in the title bar of revision and diff editors. *Compare with Working File* (`W`) follows renames too.
- **Compare a file with the base branch** in one step (`B`): the one you last picked with *Compare with Branch, Tag or Commit…* (`Shift+B`), else origin's default branch (such as `origin/main`, or a local `main`/`master`). Copy Relative Path and Reveal in Explorer View on every file row.
- **Viewed marks** for a commit's files and for the uncommitted changes: bold until you open them, and the row says how many you have seen (`3/12`, ✓ when done). `N` (or *Next Unviewed File*, `Ctrl+Alt+G Shift+N` in a diff) opens the next one, `V` or *Mark as Not Viewed* makes an opened file bold again, the commit's menu marks them all. A commit's marks follow the change, so files an amend or rebase left alone stay viewed; an uncommitted file is bold again when it changes. Tree views mark such files with a dot. On by default; off with `commitCorner.markUnviewedFiles`.
- **Collapse All Commits** in the Graph view's title bar and the editor graph's toolbar.
- **Switching repositories**: *Switch Repository* in every view's title bar, on the repository name in the graph toolbar and on `Ctrl+Alt+G Shift+O`; the picker lists the repositories you used last first, with branch, uncommitted changes and ahead/behind, and preselects the previous one.
- **Switching views**: *☰ Graph* at the top of the sidebar Graph switches to the other views (always in sight); the *Switch View* menu is now the first icon in each view's title bar.
- In the sidebar graph the `▸` of a commit comes first, and its files are indented under it.
- The editor graph opens a file's diff (and the working file) beside itself: the graph stays, with its keyboard, while you step through files. Narrow (a diff beside it), its author column shows the avatar, the SHA column goes and, narrower still, the change column is its bar, so the messages stay readable.
- Working-tree diffs never reach outside the repository: a symlink (or a device) is shown as git sees it, the link's text; a folder that is a symlink or another repository is not looked into.
- *Show Graph* moved into the Repository view's `…` menu (its title bar had become crowded).

## 1.1.0

- **Fixed:** summaries and generated commit messages came back empty when `commitCorner.ai.modelFamily` named a model that Copilot CLI lists too (Copilot CLI's models answer other extensions with nothing). They are skipped now, and Copilot's model is used when several providers offer the same one.
- `commitCorner.ai.modelFamily` also takes a model's id, its name, or provider/id (one model that several providers offer); **Choose Language Model…** lists the models that answer, stores your choice and asks again on the summary page.
- An empty answer is an error that says what came instead (a tool call, thinking…), with *Choose Model…* and *Show Log*, on the summary page and in the notification. Model refusals of any kind offer another model. The page names the model while it asks, and says when the model from the setting is not available (Generate Commit Message says it once per session).
- Stop is never reported as an error, also while the changes are read or before the model answers.
- Output → Commit Corner starts with the Commit Corner, VS Code and OS versions, and follows every language model request: the model providers' versions, the model chosen, what was sent, how the answer came (time to the first part, a line every 30 s while a model is silent), errors with their code or git's command and words, each logged once; the answer at log level Debug, the request at Trace. Script errors of the summary page are logged too.
- **Fixed:** the graph's *Uncommitted changes* row stayed ("clean") after discarding the last change while its staging area was open. It now goes until there are changes again; only right after a commit does it stay, with Amend and Undo Last Commit at hand.
- "Show Git Output" is now "Show Log".

## 1.0.0

First public release.

- **Sidebar** with six views, one at a time: Graph (with the full staging area and commit box), Repository (outgoing, branches, remotes, tags, stashes), Pull Requests, Compare, File History and Worktrees.
- **Commit graph** in an editor: branches, tags and remotes as badges, commit details, filters and search, checkout, branch, cherry-pick, revert, reset and interactive rebase from the graph.
- **Worktree review**: an agent's worktree expands to *Changes vs main*, file by file, with *Viewed* checkboxes that untick when the file changes again.
- **Pull requests (GitHub.com)**: commits and files changed with *Viewed* checkboxes, diffs against the merge base, optional details from the GitHub API (title, author, state, reviews, checks).
- **Source Control**: line and hunk staging, amend, undo last commit, stashes, protected branches, generated commit messages (Generate Commit Message, the sparkle button).
- **Summaries** of a worktree, pull request or selected commits through VS Code's Language Model API: what changed, what looks risky, what to review first.
- **History and blame**: File History, inline blame for the current line, compare any two refs, bisect, patches.
- **Repository Activity**: commits per day, people, busiest files, merged pull requests and active branches.
- **Keyboard first**: the Actions hub (`Ctrl+Alt+G Space`) and `Ctrl+Alt+G` chords for the main views; `?` in the graph lists its keys.
- Plain JavaScript, no runtime dependencies, no telemetry.
