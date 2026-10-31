# Review an agent's worktree

1. **Worktrees** lists every worktree with its uncommitted changes and how far it is ahead of its base — agents' worktrees nested in your repository (`.claude/worktrees/…`) too.
2. Expand the agent's worktree: **Changes vs main** lists everything it changed since it left the branch it was created from, committed or not.
3. `Enter` shows a file's diff (the keyboard stays in the list), `Space` ticks it off as **Viewed**. A file the agent changes again unticks itself, so the count ("2/5 viewed") always tells you what is left.
4. **Comment** with the **+** in the gutter of a file (or of a commit's diff) — what the agent should change there. **Copy Review for the Agent** (in a comment's `…` menu, on **Agent review** under the worktree, or `Ctrl+Alt+G Shift+C`) gives you one text to paste into its chat; when the agent is done, **Delete All Review Comments…** in the same menu clears them.
5. **Summarize** (the sparkle button) on that row: what changed, what looks risky, what to review first (with a language model provider such as GitHub Copilot).
