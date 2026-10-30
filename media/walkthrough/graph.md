# The graph in the sidebar

Every row reads **when · who · how much · what**: age, avatar, a green/red change bar, branch badges and the message. Labelled lines split the history into *Today, Yesterday, This week, …*.

- **Uncommitted changes** is the first row: `→` opens it as a staging area — a commit box (its sparkle button, Generate Commit Message, writes the message), then Staged / Changes / Untracked. `+` stages, `-` unstages, `Delete` discards.
- `→` on any commit shows its files; `Enter` opens the changes; `Ctrl+C` copies SHAs. Collapse All Commits (title bar) closes them all.
- Files you have not viewed yet are **bold** — a commit's and the uncommitted ones — and a commit you started on counts them (`3/12`). `N` opens the next one; `V` toggles a file's mark: *Mark as Not Viewed* (right-click) makes an opened file bold again, to come back to it later.
- On a file, `O` opens the working file (at the line you were looking at), `W` compares with it, `B` with the base branch.
- New commits (an agent's, a fetch) glow for a moment; `✎ 2` marks a commit whose worktree has uncommitted work.

`?` in the graph lists every key.
