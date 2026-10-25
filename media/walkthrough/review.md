# Review an agent's worktree

1. **Worktrees** lists every worktree with its uncommitted changes and how far it is ahead of its base — agents' worktrees nested in your repository (`.claude/worktrees/…`) too.
2. Expand the agent's worktree: **Changes vs main** lists everything it changed since it left the branch it was created from, committed or not.
3. `Enter` shows a file's diff (the keyboard stays in the list), `Space` ticks it off as **Viewed**. A file the agent changes again unticks itself, so the count ("2/5 viewed") always tells you what is left.
4. ✨ **Summarize** on that row: what changed, what looks risky, what to review first (with a language model provider such as GitHub Copilot).
