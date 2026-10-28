'use strict';

const vscode = require('vscode');
const notify = require('./notify');
const { GitError, ErrorCodes } = require('../git/exec');

/** @type {vscode.LogOutputChannel} */
let output;

function setOutput(channel) {
  output = channel;
}

/** Before activation (or in tests) messages go nowhere instead of throwing. */
const NO_LOG = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, appendLine() {}, show() {} };

function log() {
  return output || NO_LOG;
}

/** Hide credentials embedded in URLs (https://user:token@host) before they reach the log. */
function redact(text) {
  return text.replace(/(\w+:\/\/)([^/\s@:]+)(:[^/\s@]*)?@/g, '$1***@');
}

function config() {
  return vscode.workspace.getConfiguration('commitCorner');
}

function shortSha(sha) {
  return sha ? sha.slice(0, 7) : '';
}

const UNITS = [
  ['year', 365 * 24 * 3600e3],
  ['month', 30 * 24 * 3600e3],
  ['week', 7 * 24 * 3600e3],
  ['day', 24 * 3600e3],
  ['hour', 3600e3],
  ['minute', 60e3],
];

function relativeTime(ms, now = Date.now()) {
  const diff = now - ms;
  if (diff < 45e3) return 'just now';
  for (const [unit, size] of UNITS) {
    const n = Math.floor(diff / size);
    if (n >= 1) return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

function formatDate(ms) {
  const style = config().get('dateFormat', 'relative');
  if (style === 'relative') return relativeTime(ms);
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return style === 'date' ? date : `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

let globalState;
/** Called once at activation: where "Don't Show Again" choices are remembered. */
function setGlobalState(state) {
  globalState = state;
}

/**
 * An informational notification the user did not ask for, with "Don't Show Again"
 * (VS Code notification guidance). Resolves to the chosen action, or undefined.
 * @param {string} key stable id of this kind of notice
 */
async function notice(key, message, ...actions) {
  const k = `commitCorner.notice.${key}`;
  if (globalState && globalState.get(k)) return undefined;
  const choice = await notify.info(message, ...actions, "Don't Show Again");
  if (choice === "Don't Show Again") {
    if (globalState) await globalState.update(k, true);
    return undefined;
  }
  return choice;
}

/**
 * At most three characters ("now", "5m", "7h", "3d", "5w", "4mo", "2y"), padded with figure
 * spaces to a fixed width, so a column of them lines up at the start of tree labels.
 */
function tinyAge(ms, now = Date.now()) {
  const s = Math.max(0, (now - ms) / 1000);
  let t;
  if (s < 60) t = 'now';
  else if (s < 3600) t = `${Math.floor(s / 60)}m`;
  else if (s < 86400) t = `${Math.floor(s / 3600)}h`;
  else if (s < 86400 * 7) t = `${Math.floor(s / 86400)}d`;
  else if (s < 86400 * 56) t = `${Math.floor(s / 86400 / 7)}w`;
  else if (s < 86400 * 365) t = `${Math.floor(s / 86400 / 30.4)}mo`;
  else t = `${Math.floor(s / 86400 / 365)}y`;
  return t.padStart(3, '\u2007');
}

function absoluteDate(ms) {
  return new Date(ms).toLocaleString();
}

function debounce(fn, ms) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

const FRIENDLY = {
  [ErrorCodes.LocalChangesOverwritten]: 'Your local changes would be overwritten. Commit or stash them first.',
  [ErrorCodes.UntrackedOverwritten]: 'Untracked files would be overwritten. Move, commit or stash them first.',
  [ErrorCodes.NoUpstream]: 'The current branch has no upstream branch.',
  [ErrorCodes.PushRejected]: 'Push was rejected: the remote has commits you do not have. Pull first, or force push with lease.',
  [ErrorCodes.RemoteRejected]: 'The remote refused the push (for example branch protection or a server-side hook); pulling will not help.',
  [ErrorCodes.AuthenticationFailed]: 'Authentication failed. Check the credentials you entered, or configure a credential helper / SSH key for this remote.',
  [ErrorCodes.IndexLocked]: 'Another git process is running (index.lock exists). If none is running, delete .git/index.lock.',
  [ErrorCodes.NothingToCommit]: 'Nothing to commit.',
  [ErrorCodes.NoUserConfigured]: 'Git does not know who you are. Set user.name and user.email (git config --global).',
  [ErrorCodes.BranchNotFullyMerged]: 'The branch is not fully merged.',
  [ErrorCodes.Diverged]: 'Your branch and its upstream have diverged and git was not told how to combine them. Use Pull (Rebase), or set "pull.rebase" in your git config.',
  [ErrorCodes.NetworkError]: 'Could not reach the remote. Check your network connection and the remote URL.',
  [ErrorCodes.TimedOut]: 'The git operation timed out (see "commitCorner.networkTimeoutSeconds").',
};

/**
 * Show an error to the user. Git errors get a friendly message when we know
 * the category, plus a button to open the log with the raw output.
 * @param {unknown} e
 * @param {string} [context] what we were doing, e.g. "Checkout"
 */
async function showError(e, context) {
  if (e instanceof GitError && e.code === ErrorCodes.Cancelled) return;
  const detail = e instanceof GitError ? `${e.stderr || e.message}`.trim() : e && e.stack ? e.stack : String(e);
  // Already logged where it happened (with more detail): not again.
  if (output && !(e && e.logged)) output.error(`${context ? context + ': ' : ''}${detail}`);
  let message = e instanceof GitError ? FRIENDLY[e.code] || e.message : (e && e.message) || String(e);
  // Keep git's own words next to the friendly explanation: they often name the exact cause.
  if (e instanceof GitError && FRIENDLY[e.code] && e.message) {
    // A server refusal explains itself in "remote:" lines and the "[remote rejected]" reason.
    const remoteSays = e.code === ErrorCodes.RemoteRejected && `${e.stderr || ''}`.split(/\r?\n/)
      .map((l) => l.replace(/^remote:\s*/, '').trim())
      .filter((l) => /\[remote rejected\]|error|GH0\d\d|declined|protected/i.test(l) && !/failed to push some refs/.test(l))
      .join(' ');
    const gitSays = remoteSays || e.message.split('\n')[0].replace(/^(fatal|error): /, '');
    if (gitSays && !message.includes(gitSays)) message += ` (git: ${gitSays.length > 160 ? `${gitSays.slice(0, 157)}…` : gitSays})`;
  }
  if (context) message = `${context} failed: ${message}`;
  // Not awaited: the command is over when it failed (a page waiting for it, such as the graph's
  // staging area, must not stay locked until someone closes the notification).
  notify.error(message, 'Show Log').then((choice) => {
    if (choice === 'Show Log' && output) output.show(true);
  });
}

/**
 * Wrap a command implementation so failures surface as messages instead of
 * unhandled promise rejections.
 */
function safe(fn, context) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      await showError(e, context);
      return undefined;
    }
  };
}

/** Run a long git operation with a progress notification in the SCM view. */
function withProgress(title, task, location = vscode.ProgressLocation.Notification) {
  // The title is a notification message too: no links from repository text (see notify.js).
  return vscode.window.withProgress({ location, title: notify.noLinks(title), cancellable: location === vscode.ProgressLocation.Notification }, (progress, token) => {
    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());
    return task(controller.signal, progress);
  });
}

async function confirm(message, action, detail) {
  const choice = await notify.warn(message, { modal: true, detail }, action);
  return choice === action;
}

/** Escape text for use inside a MarkdownString. */
function escapeMarkdown(text) {
  return String(text).replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

/** Build a `command:` link for MarkdownStrings with trusted command URIs. */
function commandLink(label, command, args) {
  return `[${label}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`;
}

/** Status letter -> human label. */
const STATUS_LABELS = {
  M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Untracked', '?': 'Untracked', '!': 'Ignored', X: 'Unknown',
};

const STATUS_COLORS = {
  M: 'gitDecoration.modifiedResourceForeground',
  A: 'gitDecoration.addedResourceForeground',
  D: 'gitDecoration.deletedResourceForeground',
  R: 'gitDecoration.renamedResourceForeground',
  C: 'gitDecoration.addedResourceForeground',
  T: 'gitDecoration.modifiedResourceForeground',
  U: 'gitDecoration.untrackedResourceForeground',
  '?': 'gitDecoration.untrackedResourceForeground',
  '!': 'gitDecoration.conflictingResourceForeground',
};

const STATUS_ICONS = {
  M: 'diff-modified', A: 'diff-added', D: 'diff-removed', R: 'diff-renamed', C: 'diff-added', T: 'diff-modified', U: 'diff-added', '?': 'diff-added', '!': 'warning',
};

function statusIcon(status) {
  return new vscode.ThemeIcon(STATUS_ICONS[status] || 'circle-outline', new vscode.ThemeColor(STATUS_COLORS[status] || 'foreground'));
}

/**
 * Commit SHAs a command should act on: VS Code passes (clicked, allSelected[])
 * for tree multi-selection; the graph passes {shas}; single nodes carry {sha}.
 */
function selectedShas(node, nodes) {
  if (node && Array.isArray(node.shas) && node.shas.length) return node.shas.filter(isSha);
  const list = Array.isArray(nodes) && nodes.length > 1 ? nodes : [node];
  return [...new Set(list.filter((n) => n && isSha(n.sha)).map((n) => n.sha))];
}

/** Repository text shown in a label that renders $(icon) syntax (status bar items), shown literally. */
function escapeIcons(text) {
  return String(text).replace(/\$\(/g, '\\$(');
}

/**
 * Close tabs of a webview type that VS Code restored but has not revived yet (it revives a
 * restored tab only when it is shown): opening the view again would otherwise add a second tab.
 */
async function closeStaleWebviewTabs(viewType) {
  if (!vscode.window.tabGroups || !vscode.TabInputWebview) return;
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputWebview && (t.input.viewType === viewType || t.input.viewType.endsWith(`-${viewType}`)));
  if (tabs.length) await vscode.window.tabGroups.close(tabs).then(undefined, () => {});
}

/** Whether `fsPath` is (or contains) one of this window's workspace folders: "this window". */
function inThisWindow(fsPath) {
  const path = require('path');
  const real = (p) => {
    try {
      return require('fs').realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const p = real(fsPath);
  // Case-insensitive where the file system is (git prints "C:\…", VS Code "c:\…").
  const { isSameOrInside } = require('../git/pathUtil');
  return (vscode.workspace.workspaceFolders || []).some((f) => isSameOrInside(p, real(f.uri.fsPath)));
}

/** Tree views by id, for commands that act on what is selected in the focused one (Ctrl+C). */
const treeViews = new Map();
function registerTreeView(id, view) {
  treeViews.set(id, view);
  return view;
}

/** A (possibly abbreviated) commit SHA: nothing else may reach git where one is expected. */
function isSha(s) {
  return typeof s === 'string' && /^[0-9a-f]{7,64}$/.test(s);
}

/**
 * Whether the `sha` and `shas` fields of a webview message (if present) are SHAs, or one of
 * `special` (e.g. the graph's working-tree row). Messages are checked before anything runs:
 * webview content is someone else's text, and SHAs end up as git arguments.
 */
function validMessageShas(m, special = []) {
  if (!m || typeof m !== 'object') return false;
  const ok = (s) => isSha(s) || special.includes(s);
  if (m.sha !== undefined && !ok(m.sha)) return false;
  if (m.shas !== undefined && !(Array.isArray(m.shas) && m.shas.every(ok))) return false;
  return true;
}

module.exports = {
  redact,
  selectedShas,
  isSha,
  treeViews,
  registerTreeView,
  inThisWindow,
  closeStaleWebviewTabs,
  validMessageShas,
  escapeIcons,
  setOutput,
  log,
  config,
  shortSha,
  relativeTime,
  formatDate,
  tinyAge,
  notice,
  setGlobalState,
  absoluteDate,
  debounce,
  showError,
  safe,
  withProgress,
  confirm,
  escapeMarkdown,
  commandLink,
  statusIcon,
  STATUS_LABELS,
  STATUS_COLORS,
};
