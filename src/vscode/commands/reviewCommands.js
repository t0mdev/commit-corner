'use strict';

const vscode = require('vscode');
const viewed = require('../viewed');
const ai = require('../ai');
const { showError } = require('../util');

/**
 * Reviewing changes: "Viewed" marks for a whole list (a pull request's files, a worktree's
 * Changes vs Base) and a generated commit message for Source Control. Summaries are started
 * from the views that know the changes (pull requests, worktrees, the graph).
 * @param {import('../context').Context} ctx
 */
function register(ctx) {
  const { manager } = ctx;
  const cmd = ctx.command;

  // On a list node with viewedScope / viewedFiles (its view redraws it when the marks change).
  const mark = (on) => async (node) => {
    if (!node || typeof node.viewedScope !== 'string' || !Array.isArray(node.viewedFiles)) return;
    await viewed.get().set(node.viewedScope, node.viewedFiles, on);
  };
  cmd('commitCorner.viewedMarkAll', mark(true));
  cmd('commitCorner.viewedClear', mark(false));

  /**
   * ✨ in Source Control's title bar: the message box fills while the model writes. Cancel in the
   * notification stops it; typing in the box stops it too (your text is never overwritten).
   */
  cmd('commitCorner.generateCommitMessage', async (arg) => {
    const repo = await manager.pick(arg);
    const provider = repo && ctx.scm && ctx.scm.get(repo);
    if (!provider) return;
    const before = provider.message;
    let written = before;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Writing a commit message…', cancellable: true }, async (_p, token) => {
      const cts = new vscode.CancellationTokenSource();
      token.onCancellationRequested(() => cts.cancel());
      const write = (text) => {
        if (provider.message !== written) {
          cts.cancel(); // the user typed: theirs wins
          return;
        }
        provider.message = written = text;
      };
      try {
        const message = await ai.commitMessage(repo, { token: cts.token, onText: write });
        if (!cts.token.isCancellationRequested) write(message || before);
      } catch (e) {
        if (provider.message === written) provider.message = before;
        if (e instanceof ai.AiUnavailable) ai.warn(e);
        else showError(e, 'Commit message');
      } finally {
        cts.dispose();
      }
    });
  });

  cmd('commitCorner.ai.chooseModel', () => ai.pickModel());
}

module.exports = { register };
