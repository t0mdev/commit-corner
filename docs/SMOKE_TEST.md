# Manual smoke test (real VS Code)

`npm test` runs the git layer against real repositories, the VS Code layer
against an API mock, and integration suites inside real VS Code 1.140.0 and
stable (activation, editors, merge editor, webviews), plus the webviews' DOM in
VS Code 1.143.0. These checks cover what
needs a human eye. Run them after installing the packaged `.vsix`
(`npm run package && code --install-extension commit-corner-*.vsix`) and
reloading the window. Use a scratch clone with a GitHub remote.

## Source Control
- [ ] The "Commit Corner" provider shows Merge / Staged / Changes / Untracked groups.
- [ ] Select three files with Ctrl+click, right-click → Stage Changes: all three move.
- [ ] Inline buttons (open, discard, stage / unstage) work; group buttons (stage all, discard all, open all changes) work.
- [ ] Clicking a staged file opens HEAD ↔ Index; an unstaged one Index ↔ Working Tree, with syntax highlighting.
- [ ] Edit the Index side of a diff and save: `git diff --cached` shows the edit; the working file is unchanged.
- [ ] Select lines in an editor → right-click → Commit Corner → Stage Selected Lines.
- [ ] With `"git.enabled": false`: gutter markers appear; the quick-diff peek's "Stage Change" button works; Explorer badges appear.
- [ ] Commit with Ctrl+Enter; "#123 message" keeps its first line.
- [ ] Commit & Push from the Commit submenu pushes after committing.
- [ ] With `"git.enabled": false`: ignored folders are dimmed; a modified file shows Open Changes in the editor title.

## Conflicts and operations
- [ ] Merge a branch with a conflict: the status bar shows MERGE; "Resolve in Merge Editor" opens the 3-way editor (it uses VS Code's internal `_open.mergeEditor`; if the log shows "Merge editor unavailable", that command changed); stage → Continue completes the merge.
- [ ] Interactive Rebase from the graph: reorder by drag, reword, squash; the result matches the plan.
- [ ] `git rebase -i HEAD~3` in a terminal with `core.editor="code --wait"` opens the rebase editor; Start Rebase continues the terminal command; Esc → "Abort Rebase" aborts it; closing the tab shows the "runs the todo as saved" notice.

## Window reload
- [ ] Open a staged diff and a commit diff, reload the window (or reconnect WSL): both tabs show their content again (no "Unable to resolve resource").

## Remotes
- [ ] Fetch / Pull / Push show a cancellable notification; Cancel stops them.
- [ ] HTTPS remote without a credential helper: Fetch asks for username and token in an input box.
- [ ] SSH key with a passphrase (not in the agent): the passphrase is asked in a password box.
- [ ] HTTPS github.com remote, no credential helper: the first push asks to sign in with GitHub (VS Code consent dialog) and then succeeds; declining falls back to the token prompt.
- [ ] Publish a new branch: the "Create Pull Request…" offer opens github.com's compare page with the chosen base.

## Sidebar Graph and Activity
- [ ] The Commit Corner sidebar shows Graph first: rows read age │ avatar │ change bar │ message in aligned columns; Today / Yesterday / … lines separate the history; the lanes continue through them.
- [ ] The 7-day summary at the top opens Repository Activity; its period buttons, branch scope, chart tooltips (mouse and ←/→) and Table view work; clicking a person opens their commits in the graph.
- [ ] Search (title action or Ctrl+F) shows the search row; Esc hides it again.
- [ ] Switching the active repository (multi-root) switches the sidebar Graph.

## Graph, history, PRs
- [ ] Graph: lanes render; Ctrl+click two commits → Open Combined Diff opens the multi-diff editor.
- [ ] Right-click a commit and a branch badge: the native context menus appear.
- [ ] File History: select two revisions → Compare Selected Revisions.
- [ ] Current-line blame shows after the line; the hover links work; Blame Before This Change opens the older revision.
- [ ] Pull Requests view (github.com remote) shows titles, authors, state icons and Today / This week / … lines; expanding one shows review state and checks, then commits and files. With `commitCorner.pullRequests.githubApi` set to `off` it lists PR numbers from git.
- [ ] File History and branch commit lists show Today / Yesterday / … separator rows.
- [ ] The Worktrees view is the sixth view; Delete on a worktree asks before removing it.
- [ ] Previous / next revision buttons in a diff editor step through the file's history.
- [ ] Graph: badges have icons, avatars show initials, the Changes column fills in while scrolling; hovering a row shows no pop-up; Push/Pull show counts.
- [ ] Repository view (branches): commit rows show an avatar icon (also in WSL/remote windows), age and +/−; the tooltip links work.
- [ ] Worktrees overview (`Ctrl+Alt+G W`) lists every worktree with its state; Open / Remove work; it updates after editing a file in a worktree.

## Keyboard only (no mouse, US layout)
- [ ] Graph: Shift+F10 opens the commit menu next to the cursor row; with three commits selected (Shift+↓) it offers "Show Range Changes".
- [ ] Graph: Ctrl+A highlights the commits, not the page text; Ctrl+C copies SHAs (paste to check that only SHAs arrive).
- [ ] Graph: with a screen reader (NVDA / Narrator), ↓ announces each commit; `?` opens the help dialog.
- [ ] Repository view: ↓ to a merged branch, Delete → confirm deletes it; F2 renames; Delete on the current branch does nothing.
- [ ] Repository view, Stashes group: Delete drops the focused stash after confirming.
- [ ] `Ctrl+Alt+G Shift+P` pushes, `Ctrl+Alt+G Shift+F` pulls; during a bisect `Ctrl+Alt+G Shift+G` / `Shift+X` mark commits.
- [ ] Focus a file in the Source Control list and press `Ctrl+Alt+G A`: nothing is staged (the chord only acts from an editor).
- [ ] Rebase editor: Ctrl+Z / Ctrl+Y undo and redo plan changes (and do not also trigger VS Code's own undo); `R` puts the cursor in the message; Esc, Esc asks before discarding; Home/End jump; the focused row has a visible outline in a high-contrast theme.
