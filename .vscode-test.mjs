// Integration tests in a real VS Code (https://code.visualstudio.com/api/working-with-extensions/testing-extension).
// Each run opens its own throwaway git repository as the workspace.
import { defineConfig } from '@vscode/test-cli';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Workspaces made for this run: removed when the test run ends. */
const made = [];
process.on('exit', () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

/** A small repository with a little history, created fresh for every run. */
function workspace(label, settings) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `cc-vscode-${label}-`)));
  made.push(dir, `${dir}-agent`);
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' } });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Initial commit');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n');
  git('commit', '-q', '-am', 'Change two');
  git('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(dir, 'c.txt'), 'feature\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Feature work');
  git('checkout', '-q', 'main');
  if (settings) {
    // Workspace settings (e.g. the built-in Git switched off), kept out of the repository's status.
    fs.mkdirSync(path.join(dir, '.vscode'));
    fs.writeFileSync(path.join(dir, '.vscode', 'settings.json'), JSON.stringify(settings, null, 2));
    fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '.vscode/\n');
  }
  return dir;
}

/**
 * The UI tests' workspace (test/ui): a repository with uncommitted work in every group (changed,
 * staged, untracked) and an agent worktree next to it with work since it left main.
 */
function uiWorkspace() {
  const dir = workspace('ui');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git(dir, 'worktree', 'add', '-q', '-b', 'agent', `${dir}-agent`);
  fs.writeFileSync(path.join(`${dir}-agent`, 'agent.txt'), 'the agent was here\n');
  git(`${dir}-agent`, 'add', 'agent.txt');
  git(`${dir}-agent`, '-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', 'commit', '-q', '-m', 'Agent work');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b changed\n');
  fs.writeFileSync(path.join(dir, 'staged.txt'), 'staged\n');
  git(dir, 'add', 'staged.txt');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n');
  return dir;
}

/** DevTools port of the UI tests' VS Code (they read the webviews' DOM through it). */
const uiPort = String(9300 + Math.floor(Math.random() * 600));

const common = {
  files: 'test/integration/**/*.test.js',
  mocha: { ui: 'tdd', timeout: 60000 },
  // Only this extension (built-ins stay); the folder is trusted so the extension may run.
  launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
};

export default defineConfig([
  // engines.vscode minimum
  { ...common, label: 'minimum', version: '1.140.0', workspaceFolder: workspace('min') },
  { ...common, label: 'stable', version: 'stable', workspaceFolder: workspace('stable') },
  // Replacement mode: the built-in Git is off, so the "auto" features (quick diff, Explorer
  // decorations, status bar, count badge) switch on.
  { ...common, label: 'replacement', version: '1.140.0', workspaceFolder: workspace('replace', { 'git.enabled': false }) },
  // The webviews' DOM (test/ui): the graph's staging area and the summary page, with a test
  // language model (test/ui/fakelm) as a second extension. Needs a display, like the others.
  {
    label: 'ui',
    version: '1.143.0',
    files: 'test/ui/**/*.test.js',
    mocha: { ui: 'tdd', timeout: 60000 },
    extensionDevelopmentPath: ['.', './test/ui/fakelm'],
    workspaceFolder: uiWorkspace(),
    launchArgs: ['--disable-extensions', '--disable-workspace-trust', `--remote-debugging-port=${uiPort}`],
    env: { CC_UI_CDP_PORT: uiPort },
  },
]);
