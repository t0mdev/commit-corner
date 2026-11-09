# Changelog

## Unreleased

- **Staging a file that belongs to another repository inside yours now says so.** git silently skips such a file, for example in an agent's copy under `.local-work/` that got its own `.git` after its files were listed, so `+` seemed to do nothing. Commit Corner now warns which files were left out and offers *Open Repository*, which shows that repository's Source Control. The other files you picked are still staged. *Commit Selected* with such a file commits nothing, leaves the index as it was, and says why.
- A repository appearing inside yours (an agent's `git clone` or `git init`) is noticed right away: its files leave the list, and come back if its `.git` is removed.
- **Status limit**: when one folder floods Source Control (agents' copies of the repository, a build output), the warning names it, for example `src/generated/` rather than `src/`. If git tracks no files in it, it also offers *Exclude "folder/" Locally*. That writes the folder to `.git/info/exclude`, so it is ignored in your clone only and there is nothing to commit. Counts show thousands separators.
- Refreshes no longer pile up while agents keep writing: Source Control stays current even when `git status` is slow, and a `git status` that hangs holds later refreshes for a minute at most. A refresh that finds the same status leaves Source Control's lists and the Explorer decorations as they are, and past the status limit an untracked file that only changes its content causes no refresh at all.
- **Staging thousands of new files at once** (the *Untracked* group's `+`, or a folder in `untrackedFiles: normal` mode) stages folder by folder instead of file by file: 100,000 files take seconds instead of minutes. Exactly the files listed are staged (not ones made since), and repositories inside those folders stay out.
- Staging, committing and other writes wait up to 5 seconds while another git process holds `index.lock`, for example an agent's commit running its hooks (before, about 1 second). The status bar's *git …* item says it is waiting for index.lock and can cancel it. A lock over 10 minutes old fails right away and names the file to delete (probably left behind by a git process that crashed).
- **Compare with…** on a commit or a branch/tag badge in the graph (right-click, or the row's `…` menu) and on branches, tags and commits in the tree views: pick any branch, tag, commit or the working tree to compare it with. A branch/tag badge in the graph also has *Compare with Working Tree* now.
- Fixed: closing the Repository Activity or Worktrees page while it was loading could log "Webview is disposed" errors.

## 1.6.0

- **Changed: the *Viewed* checkboxes are gone, and so is `Space` to tick a file.** A pull request's *Files changed* and a worktree's *Changes vs main* now show what you have not seen the way a commit's files do: a file you have not opened has a dot, and opening it (click or `Enter`; the keyboard stays in the list, `↓` `Enter` for the next) marks it viewed. *Mark as Not Viewed* in its menu (`Shift+F10`) brings the dot back. Files you had checked stay viewed. If you had turned `commitCorner.markUnviewedFiles` off, these lists now show no dots either (they still count what you opened); turn it on to see them.
  - A push or an agent's edit that changes a file brings its dot back.
  - *Next Unviewed File* (`Ctrl+Alt+G N`, or its button in the diff's title bar) works in their diffs too: it opens the next file of that list not viewed yet.
  - *Mark as Viewed* / *Mark as Not Viewed* on a file, and in the Pull Requests and Compare views also on several selected files or a folder. The list's row keeps its count ("2/5 viewed") and *Mark All as Viewed* / *Mark All as Not Viewed* (formerly "Clear Viewed Marks", also on commits).
  - The dots follow `commitCorner.markUnviewedFiles`. With it off these lists show no dots but still count what you opened, and their Mark menus stay.
  - A file that cannot be marked (a symbolic link, a submodule) says so in its tooltip.
  - *Copy Relative Path* on a worktree's changed file.
- **The Compare view marks what you have not seen too**: a dot on each changed file until you open it, counted on *Files changed* ("+12 −3 · 2/5 viewed"), with the same menus and *Next Unviewed File*. Opening a file keeps the keyboard in the list, as in a pull request. Compared with the working tree, a file you (or an agent) edit again gets its dot back (only *Files changed* is redrawn, and only when something in it changed); between two refs, a file keeps its mark until its content on the right side changes. A deleted file's menus read the version shown on the left.
- A folder in these trees (and in a commit's files) has a dot while a file in it has not been opened, so a collapsed folder says so too.
- *Next Unviewed File* selects the file it opens in its list, so `Enter` / `↓` there go on from it.
- **Which repository you are in**: the sidebar Graph shows its name at the top, next to *☰ Graph*; with several repositories open, a click on it switches, and the other views start with a row naming theirs (a click switches there too; Compare and File History then show the repository picked, however you switch). The separate Switch Repository button in the other views' title bars moved into their `···` menu.
- A folder's right-click menu in the tree views (Compare, Pull Requests, a commit's files, …) has **Collapse This Level** (the folder and the folders next to it) and **Collapse Folder**.
- **Review Comments** submenu in each Commit Corner view's `···` menu, while there are review comments: Copy Review for the Agent (with its shortcut, `Ctrl+Alt+G C`), Save Review to the Worktree, Delete All Review Comments….
- Fixed: a large pull request opened for the first time could show only part of its files until you refreshed.
- Fixed: *Open File at Commit*, *Compare with Working Tree* and *Restore File from Commit* on a file a pull request (or a merge's other side) deleted now use the version before the pull request, not the parent of its last commit.

## 1.5.0

- **Merge Resolution**: what a merge commit itself changed, beyond git's automatic merge of its parents: the conflicts it resolved (marked *conflict*, the markers on the left side) and anything else edited while merging. git merges the parents again for it (`merge-tree`, nothing in your working tree or index changes); a clean merge says so. With git older than 2.38 it is merged again without rename detection, merge drivers or several merge bases and marked approximate; a merge with more than 1000 files (or 64 MB) changed on both sides, or one in a partial clone, shows its resolution as unavailable there. A shallow clone without the merge's base says so.
- **Opening a merge asks which changes**: *Show Changes* on a merge commit offers Merge Resolution, Changes vs Parent 1 (what the merge brought in) and Changes vs Parent 2 (what differs from the merged-in branch), with each parent's commit and the file counts; Enter takes the resolution, or Parent 1 when the merge turns out clean. The graph's expanded row and details pane and the trees list the three as sections under the merge (the same way: open is the resolution, or Parent 1 for a clean merge; the others load when you open them; `A` on a section in the graph opens all its files). *Show Merge Resolution* is in a merge's menus and hover card; *Show Changes vs Parent 2* (formerly "Against Second Parent") is only offered on merges now. Diffs opened from a section say which side they compare (`app.js (automatic merge ↔ 1a2b3c4)`).
- Next Unviewed File (`N`) in a merge's resolution or second-parent diff goes to the next file of that list.

## 1.4.0

- **Shortcuts changed** (after `Ctrl+Alt+G`, `Cmd+Alt+G` on macOS): the keys used most while reviewing an agent's work are single letters now.
  - `N` next unviewed file (was `Shift+N`), `W` open the working file (was `Shift+W`; elsewhere it says where it works), `C` copy the review for the agent (was `Shift+C`; with comments in several worktrees it takes the one of the file in front of you).
  - Moved to `Shift`: `Shift+N` create a pull request, `Shift+W` worktrees overview, `Shift+C` compare refs.
  - New: `Shift+D` shows the changes of a worktree vs its base (the worktree of the file you have open comes first).
  - Unchanged: push is `Shift+P`, `P` opens a pull request.
- Each review comment has a `…` menu: **Copy Review for the Agent**, **Save Review to the Worktree** and, in its own group, **Delete All Review Comments…**. They act on that comment's worktree, without asking which. Delete All asks first and says how many comments (and replies) in which files go.
- While you edit a comment, Copy and Save tell you to save (or cancel) it first: the review takes the saved text. With no comments (or review comments turned off), Copy, Save and Delete All say so; their worktree picker says what it is for.
- The Actions hub (`Ctrl+Alt+G Space`) has a Review group: next unviewed file, open working file, copy, save, delete all.
- The interactive rebase editor no longer takes the key after `Ctrl+Alt+G` as its own (`Ctrl+Alt+G S` marked the commit "squash", `Ctrl+Alt+G Ctrl+Alt+Enter` started the rebase); in the graph it no longer lands in the commit message box, even when it comes a few seconds later; the worktrees overview, activity and summary pages leave it to VS Code too (`Ctrl+Alt+G Enter` opened a worktree card, `Ctrl+Alt+G Escape` stopped a summary).

## 1.3.0

- **Review comments for the agent**: the **+** in the gutter of a worktree's files (or the repository's) and of a commit's diff adds a comment on that line (Markdown; a comment on an agent's commit belongs to its worktree). **Copy Review for the Agent** (`Ctrl+Alt+G Shift+C`) puts all of a worktree's comments together — file, lines, the code as it is now, your comments — as one text to paste into the agent's chat; **Save Review to the Worktree** writes it as `.review-comments.md` there, ignored by git. Comments move with edits above them and say when their own lines changed (the review then shows the lines as they were and as they are now). The Worktrees view shows how many a worktree has and lists them under **Agent review**. Settings: `commitCorner.review.comments`, `commitCorner.review.fileName`.

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
