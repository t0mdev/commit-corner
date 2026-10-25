'use strict';

const vscode = require('vscode');
const notify = require('./vscode/notify');
const exec = require('./git/exec');
const { setOutput, config, log } = require('./vscode/util');
const { RepositoryManager } = require('./vscode/model');
const { GitFileSystemProvider } = require('./vscode/fsProvider');
const { ScmManager } = require('./vscode/scm');
const { Context } = require('./vscode/context');
const { BranchesView } = require('./vscode/views/branchesView');
const { register: registerStashes } = require('./vscode/views/stashesView');
const { WorktreesView, register: registerWorktrees } = require('./vscode/views/worktreesView');
const { PullRequestsView, register: registerPullRequests } = require('./vscode/views/pullRequestsView');
const { CompareView, register: registerCompare } = require('./vscode/views/compareView');
const { FileHistoryView, register: registerFileHistory } = require('./vscode/views/fileHistoryView');
const { FileDecorations } = require('./vscode/decorations');
const { AskpassServer } = require('./git/askpass');

/** @param {vscode.ExtensionContext} extContext */
async function activate(extContext) {
  const output = vscode.window.createOutputChannel('Commit Corner', { log: true });
  extContext.subscriptions.push(output);
  setOutput(output);

  exec.configure({
    gitPath: config().get('gitPath') || 'git',
    logger: ({ args, ms, exitCode, stderr }) => {
      const line = redact(`git ${args.join(' ')} → ${exitCode === null ? 'cancelled' : exitCode} (${ms} ms)`);
      stderr = stderr && redact(stderr);
      if (exitCode !== 0 && exitCode !== null && stderr) output.debug(`${line}\n${stderr.trim()}`);
      else output.trace(line);
    },
  });
  try {
    const v = await exec.getVersion();
    output.info(`Using ${v.raw}`);
  } catch (e) {
    output.error(e.message);
    notify.error(`Commit Corner: ${e.message}`);
    // Keep every menu item and shortcut answering with the reason instead of "command not found".
    const { contributes } = require('../package.json');
    for (const c of contributes.commands) {
      extContext.subscriptions.push(vscode.commands.registerCommand(c.command, () => {
        notify.error(`Commit Corner: ${e.message}`, 'Open Settings').then((choice) => {
          if (choice) vscode.commands.executeCommand('workbench.action.openSettings', 'commitCorner.gitPath');
        });
      }));
    }
    // Fixing commitCorner.gitPath needs a fresh start of the extension: offer the reload.
    extContext.subscriptions.push(vscode.workspace.onDidChangeConfiguration((ev) => {
      if (!ev.affectsConfiguration('commitCorner.gitPath')) return;
      notify.info('Reload the window to use the new git path.', 'Reload Window').then((c) => {
        if (c) vscode.commands.executeCommand('workbench.action.reloadWindow');
      });
    }));
    return undefined;
  }

  await startAskpass(extContext);

  const manager = new RepositoryManager();
  manager.memento = extContext.workspaceState;
  require('./vscode/util').setGlobalState(extContext.globalState);
  extContext.subscriptions.push(manager);
  const ctx = new Context(extContext, manager);
  require('./vscode/avatars').init(extContext.globalStorageUri);
  extContext.subscriptions.push(require('./vscode/viewed').init(extContext.workspaceState));
  const remoteUrl = require('./git/remoteUrl');
  remoteUrl.setGithubHostAliases(config().get('githubHostAliases', []));
  extContext.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('commitCorner.githubHostAliases')) remoteUrl.setGithubHostAliases(config().get('githubHostAliases', []));
  }));
  manager.ready = new Promise((resolve) => (ctx.resolveReady = resolve));

  ctx.own(new GitFileSystemProvider(manager));
  ctx.scm = ctx.own(new ScmManager(manager));

  require('./vscode/commands/scmCommands').register(ctx);
  require('./vscode/commands/lineStaging').register(ctx);
  require('./vscode/commands/branchCommands').register(ctx);
  require('./vscode/commands/historyCommands').register(ctx);
  require('./vscode/commands/repoCommands').register(ctx);
  require('./vscode/commands/navigationCommands').register(ctx);
  require('./vscode/commands/actionsHub').register(ctx);
  require('./vscode/commands/createPullRequest').register(ctx);
  require('./vscode/commands/reviewCommands').register(ctx);
  require('./vscode/sidebar').register(ctx);
  require('./vscode/github').register(ctx);
  ctx.own(new FileDecorations(manager));

  // Repository view: branches, tags and stashes; worktrees have their own view (by design:
  // six views, one more than VS Code's 3-5 suggestion).
  const branchesView = ctx.own(new BranchesView(manager));
  registerStashes(ctx);
  const worktreesView = ctx.own(new WorktreesView(manager));
  registerWorktrees(ctx);
  const prs = ctx.own(new PullRequestsView(manager, extContext));
  registerPullRequests(ctx, prs);
  require('./vscode/commands/viewKeys').register(ctx, { branches: branchesView, worktrees: worktreesView, pullRequests: prs });
  ctx.compare = ctx.own(new CompareView(manager));
  registerCompare(ctx, ctx.compare);
  const history = ctx.own(new FileHistoryView(manager));
  registerFileHistory(ctx, history);

  ctx.own(require('./vscode/webviews/graphPanel').register(ctx));
  ctx.own(require('./vscode/webviews/rebaseEditor').register(ctx));
  ctx.own(require('./vscode/webviews/worktreesPanel').register(ctx));
  ctx.own(require('./vscode/webviews/activityPanel').register(ctx));
  ctx.own(require('./vscode/blame').register(ctx));
  ctx.own(require('./vscode/statusBar').register(ctx));

  ctx.command('commitCorner.showOutput', () => output.show());
  ctx.command('commitCorner.replaceBuiltInGit', () => askReplacingBuiltInGit(extContext, { modal: true }));
  ctx.command('commitCorner.openRepository', async () => {
    const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Open Repository' });
    if (!pick || !pick[0]) return;
    const repo = await manager.openRepository(pick[0].fsPath);
    if (!repo) notify.warn(`${pick[0].fsPath} is not inside a git repository.`);
    else manager.setActive(repo);
  });
  ctx.command('commitCorner.switchRepository', async () => {
    const repos = manager.repositories;
    if (!repos.length) return;
    const pick = await vscode.window.showQuickPick(repos.map((r) => ({ label: r.name, description: r.root, picked: r === manager.active, repo: r })), { placeHolder: 'Repository shown in Commit Corner views' });
    if (pick) manager.setActive(pick.repo);
  });

  extContext.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('commitCorner.gitPath')) exec.configure({ gitPath: config().get('gitPath') || 'git' });
  }));

  await manager.initialize();
  ctx.resolveReady();
  manager.updateContextKeys();
  log().info(`Activated with ${manager.repositories.length} repositor${manager.repositories.length === 1 ? 'y' : 'ies'}`);
  if (manager.repositories.length) offerReplacingBuiltInGit(extContext).catch((e) => log().warn(e.message));
  return { manager, registeredCommands: ctx.registered, scm: ctx.scm };
}

/**
 * Both Git UIs on: Source Control lists every repository twice and two blames compete. Offer,
 * once, to switch the built-in one off (a user setting, undone in Settings any time). The offer
 * is a notification and a status bar entry that stays until it is answered (a notification that
 * arrives while VS Code starts can go straight to the notification center, unseen).
 */
async function offerReplacingBuiltInGit(extContext) {
  const key = 'offer.replaceBuiltInGit'; // globalState key
  const scm = require('./vscode/scm');
  if (!scm.builtInGitEnabled() || extContext.globalState.get(key)) return;
  // Not a nag: left unanswered on two starts, it counts as "Keep Both".
  const shown = (extContext.globalState.get(`${key}.shown`) || 0) + 1;
  await extContext.globalState.update(`${key}.shown`, shown);
  if (shown > 2) {
    await extContext.globalState.update(key, 'Keep Both');
    return;
  }
  const item = vscode.window.createStatusBarItem('commitCorner.replaceBuiltInGit', vscode.StatusBarAlignment.Left, -100);
  item.name = 'Commit Corner: Built-in Git';
  item.text = '$(source-control) Built-in Git is on too';
  item.tooltip = 'Source Control shows each repository twice. Click to choose which Git UI to use.';
  item.command = 'commitCorner.replaceBuiltInGit';
  item.show();
  extContext.subscriptions.push(item);
  offerItem = item;
  // After start-up, when the window has the user's attention.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  if (!vscode.window.state.focused) {
    await new Promise((resolve) => {
      const d = vscode.window.onDidChangeWindowState((st) => {
        if (st.focused) {
          d.dispose();
          resolve();
        }
      });
      extContext.subscriptions.push(d);
    });
  }
  if (!extContext.globalState.get(key)) await askReplacingBuiltInGit(extContext, { modal: false });
}

/** @type {vscode.StatusBarItem|undefined} the offer's status bar entry, until it is answered */
let offerItem;

async function askReplacingBuiltInGit(extContext, { modal }) {
  const key = 'offer.replaceBuiltInGit';
  if (!require('./vscode/scm').builtInGitEnabled()) {
    notify.info('The built-in Git is already off: Commit Corner is your Git UI.');
    return;
  }
  const text = 'VS Code\'s built-in Git is on too, so Source Control shows each repository twice. Use Commit Corner only?';
  const detail = 'Extensions that rely on the built-in Git API, such as GitHub Pull Requests, then stop seeing your repositories. You can turn it back on in Settings ("git.enabled").';
  const choice = modal
    ? await notify.info(text, { modal: true, detail }, 'Use Commit Corner Only', 'Keep Both', 'Learn More')
    : await notify.info(`${text} (${detail.split('.')[0]}.)`, 'Use Commit Corner Only', 'Keep Both', 'Learn More');
  if (choice === 'Learn More') {
    vscode.env.openExternal(vscode.Uri.parse('https://github.com/t0mdev/commit-corner#coexisting-with-the-built-in-git-extension'));
    return; // asked again next time
  }
  if (!choice) return;
  await extContext.globalState.update(key, choice);
  if (offerItem) {
    offerItem.dispose();
    offerItem = undefined;
  }
  if (choice === 'Use Commit Corner Only') {
    await vscode.workspace.getConfiguration('git').update('enabled', false, vscode.ConfigurationTarget.Global);
    const reload = await notify.info('The built-in Git is off (setting "git.enabled"). Reload the window to finish.', 'Reload Window');
    if (reload) vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

/**
 * Route git/ssh credential prompts (HTTPS username/password or token, SSH
 * key passphrases, host key confirmation) to VS Code dialogs.
 */
async function startAskpass(extContext) {
  if (!config().get('askpass', true)) return;
  const github = require('./vscode/github');
  let hinted = false;
  const server = new AskpassServer(async (prompt, { quiet, ssh, lease = {} } = {}) => {
    const text = prompt.trim();
    // github.com over HTTPS: the GitHub account signed in to VS Code — never for ssh, and only
    // for commands started with git's credential helpers off (else one could store the token).
    const fromGitHub = await github.answerGitPrompt(text, { quiet, ssh, helpersOff: !!lease.helpersOff });
    if (fromGitHub !== undefined) return fromGitHub;
    if (quiet) return undefined; // background work never asks
    if (/continue connecting \(yes\/no/i.test(text)) {
      const choice = await notify.warn(text, { modal: true }, 'Yes', 'No');
      return choice === 'Yes' ? 'yes' : choice === 'No' ? 'no' : undefined;
    }
    if (!ssh && !hinted && github.isGitHubPrompt(text)) {
      // Not signed in when this command started: ask as usual, and say how to skip it next time.
      hinted = true;
      notify.info('Sign in to GitHub in VS Code, and pushes and pulls to github.com use that account without asking.', 'Sign In').then((c) => {
        if (c) vscode.commands.executeCommand('commitCorner.githubSignIn');
      });
    }
    return vscode.window.showInputBox({
      // ssh prompts are the server's words: say so, so they cannot pass for git's own.
      title: ssh ? 'Commit Corner: the SSH server asks' : 'Commit Corner: git needs credentials',
      // The text comes from git or the server (ssh chooses its own prompts): one line, and no
      // links or icons, which the input box would otherwise render.
      prompt: notify.plainText(text),
      password: /password|passphrase|token|pin\b/i.test(text),
      ignoreFocusOut: true,
    });
  }, extContext.globalStorageUri.fsPath);
  try {
    await server.start();
    // Each network command: its own askpass token, and (signed in) no credential helper that
    // could store the GitHub token.
    exec.configure({
      env: () => {
        const config = github.gitCredentialConfig();
        const lease = server.lease({ helpersOff: config.length > 0 });
        lease.config = config;
        return lease;
      },
    });
    extContext.subscriptions.push(server);
  } catch (e) {
    log().warn(`Credential prompts unavailable: ${e.message}`);
  }
}

/** Hide credentials embedded in URLs (https://user:token@host) before they reach the log. */
function redact(text) {
  return text.replace(/(\w+:\/\/)([^/\s@:]+)(:[^/\s@]*)?@/g, '$1***@');
}

function deactivate() {}

module.exports = { activate, deactivate, redact };
