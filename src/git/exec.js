'use strict';

const { spawn } = require('child_process');

/**
 * Low-level git process runner. Never goes through a shell: arguments are
 * passed as an array, so paths and user input cannot be interpreted as shell
 * syntax.
 */

let gitPath = 'git';
/**
 * Environment for git processes that talk to a remote (the askpass configuration). Local
 * commands (commit, rebase, checkout, …) run hooks and filters from the repository; they do not
 * get it, so their hooks cannot ask the extension for credentials. A network command gets a
 * lease of its own that is revoked when the command exits, so hooks it runs (pre-push,
 * reference-transaction, …) cannot keep the channel for later. While the command runs they can
 * still reach it: hooks run as you, with your permissions, like git itself.
 * `config`: git configuration for that command, as `-c` arguments (every git version reads
 * those, unlike GIT_CONFIG_COUNT, which needs 2.31).
 * @type {() => {env: Record<string,string>, release: () => void, config?: [string, string][]}}
 */
let leaseEnv = () => ({ env: {}, release() {} });
/** @type {(entry: {args: string[], cwd: string, ms: number, exitCode: number, stderr: string}) => void} */
let logger = () => {};

function getGitPath() {
  return gitPath;
}

/**
 * The environment git starts from: VS Code's, minus variables that would point git at another
 * repository, index or object store (set when VS Code was started from a git hook or alias).
 * Callers that mean them (a temporary index) pass them in opts.env.
 */
const REPOSITORY_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE'];
function inheritedEnv() {
  const env = { ...process.env };
  for (const k of REPOSITORY_VARIABLES) delete env[k];
  return env;
}

function configure(options) {
  if (options.gitPath && options.gitPath !== gitPath) {
    gitPath = options.gitPath;
    versionPromise = undefined; // a different git may have different features
  }
  if (options.logger) logger = options.logger;
  if (options.env) leaseEnv = typeof options.env === 'function' ? options.env : () => ({ env: options.env, release() {} });
}

/** Error categories derived from git's stderr, so callers can react without regexes everywhere. */
const ErrorCodes = Object.freeze({
  NotARepository: 'NotARepository',
  Conflict: 'Conflict',
  LocalChangesOverwritten: 'LocalChangesOverwritten',
  UntrackedOverwritten: 'UntrackedOverwritten',
  NoUpstream: 'NoUpstream',
  PushRejected: 'PushRejected',
  RemoteRejected: 'RemoteRejected',
  AuthenticationFailed: 'AuthenticationFailed',
  IndexLocked: 'IndexLocked',
  NothingToCommit: 'NothingToCommit',
  BranchNotFullyMerged: 'BranchNotFullyMerged',
  NoUserConfigured: 'NoUserConfigured',
  Cancelled: 'Cancelled',
  TimedOut: 'TimedOut',
  Diverged: 'Diverged',
  NetworkError: 'NetworkError',
  PullRequestUpstream: 'PullRequestUpstream',
  UpstreamNameMismatch: 'UpstreamNameMismatch',
  NotFound: 'NotFound',
  Unknown: 'Unknown',
});

const ERROR_PATTERNS = [
  [/not a git repository/i, ErrorCodes.NotARepository],
  [/index\.lock': File exists|Unable to create .*\.lock/i, ErrorCodes.IndexLocked],
  [/CONFLICT \(|Automatic merge failed|could not apply|after resolving the conflicts|needs merge|you need to resolve your current index first|with conflicts\./i, ErrorCodes.Conflict],
  [/Your local changes to the following files would be overwritten|Please commit your changes or stash them/i, ErrorCodes.LocalChangesOverwritten],
  [/untracked working tree files would be (overwritten|removed)/i, ErrorCodes.UntrackedOverwritten],
  [/has no upstream branch|no tracking information|There is no tracking information/i, ErrorCodes.NoUpstream],
  [/Need to specify how to reconcile divergent branches|Not possible to fast-forward/i, ErrorCodes.Diverged],
  // Refused by the server (branch protection, push rules, pre-receive hooks): pulling does not help.
  [/\[remote rejected\]|pre-receive hook declined|\bGH0\d\d\b|protected branch/i, ErrorCodes.RemoteRejected],
  [/\[rejected\]|Updates were rejected|stale info|failed to push some refs/i, ErrorCodes.PushRejected],
  // Authentication before network: "unable to access … 403" and "Could not read from remote repository"
  // also appear for credential problems.
  [/Authentication failed|could not read Username|could not read Password|Permission denied \(publickey|terminal prompts disabled|returned error: 40[13]|Repository not found|access denied/i, ErrorCodes.AuthenticationFailed],
  [/Connection timed out|Could not resolve host|unable to access|Could not read from remote repository|Connection refused|Network is unreachable/i, ErrorCodes.NetworkError],
  [/nothing to commit|no changes added to commit|nothing added to commit/i, ErrorCodes.NothingToCommit],
  [/is not fully merged/i, ErrorCodes.BranchNotFullyMerged],
  [/Please tell me who you are|unable to auto-detect email address/i, ErrorCodes.NoUserConfigured],
  [/does not exist in|exists on disk, but not in|bad revision|unknown revision|Not a valid object name|invalid object name|path .* does not exist/i, ErrorCodes.NotFound],
];

/**
 * The useful part of git's output for a message: `fatal:`/`error:` lines when
 * there are any (fetch/pull also print progress such as "From …" and ref
 * updates), otherwise everything except hints.
 */
function summarize(text) {
  const lines = (text || '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l && !/^hint:/.test(l));
  const important = lines.filter((l) => /^(fatal|error|CONFLICT)\b/.test(l));
  return (important.length ? important : lines).join('\n');
}

class GitError extends Error {
  constructor({ args, exitCode, stdout, stderr, cwd, timedOut }) {
    const summary = timedOut ? `git ${args[0]} timed out` : summarize(stderr) || summarize(stdout);
    super(summary || `git ${args[0]} failed with exit code ${exitCode}`);
    this.name = 'GitError';
    this.args = args;
    this.cwd = cwd;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
    this.code = timedOut ? ErrorCodes.TimedOut : classify(`${stderr}\n${stdout}`, exitCode);
  }
}

function classify(text, exitCode) {
  if (exitCode === null) return ErrorCodes.Cancelled;
  for (const [re, code] of ERROR_PATTERNS) if (re.test(text)) return code;
  return ErrorCodes.Unknown;
}

/**
 * Run git.
 * @param {string[]} args
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {string|Buffer} [opts.input] data written to stdin
 * @param {boolean} [opts.buffer] return stdout as Buffer instead of string
 * @param {AbortSignal} [opts.signal]
 * @param {Record<string,string>} [opts.env] extra environment variables
 * @param {boolean} [opts.allowFailure] resolve instead of reject on non-zero exit
 * @param {number} [opts.maxBytes] stop reading stdout after this many bytes (result.truncated = true)
 * @param {number} [opts.timeout] kill git after this many milliseconds (rejects with code TimedOut)
 * @param {boolean} [opts.network] talks to a remote: gets the credential-prompt (askpass) environment
 * @returns {Promise<{stdout: any, stderr: string, exitCode: number, truncated: boolean}>}
 */
function git(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const lease = opts.network ? leaseEnv() : undefined;
    const env = {
      ...inheritedEnv(),
      // Never block on an interactive credential prompt: there is no terminal.
      GIT_TERMINAL_PROMPT: '0',
      ...(lease ? lease.env : {}),
      ...opts.env,
    };
    englishMessages(env);
    // No inherited editor (GIT_EDITOR=vim, …) may hang a child process: callers that want an
    // editor pass one explicitly.
    env.GIT_EDITOR = (opts.env && opts.env.GIT_EDITOR) || 'true';
    let child;
    try {
      // Keep output parseable regardless of user config; patches always use a/ b/ prefixes.
      // safe.bareRepository=explicit: a bare repository committed inside another repository
      // is never picked up implicitly (its config could name programs; git >= 2.38).
      const leased = lease && lease.config ? lease.config.flatMap(([k, v]) => ['-c', `${k}=${v}`]) : [];
      child = spawn(gitPath, [...leased, '-c', 'safe.bareRepository=explicit', '-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'color.diff=false', '-c', 'color.status=false', '-c', 'color.branch=false', '-c', 'color.grep=false', '-c', 'log.showSignature=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', ...args], {
        cwd: opts.cwd,
        env,
        windowsHide: true,
      });
    } catch (e) {
      if (lease) lease.release();
      reject(e);
      return;
    }

    const out = [];
    let outBytes = 0;
    let truncated = false;
    const err = [];
    child.stdout.on('data', (chunk) => {
      if (truncated) return;
      if (opts.maxBytes && outBytes + chunk.length > opts.maxBytes) {
        out.push(chunk.subarray(0, opts.maxBytes - outBytes));
        outBytes = opts.maxBytes;
        truncated = true;
        child.kill();
        return;
      }
      out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.stdin.on('error', () => { /* process exited before reading stdin; reported via exit code */ });

    let aborted = false;
    let timedOut = false;
    const onAbort = () => {
      aborted = true;
      child.kill();
    };
    const timer = opts.timeout ? setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeout) : undefined;
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (e) => {
      if (lease) lease.release();
      // spawn says ENOENT for a missing working folder too: that is not a missing git.
      if (e && e.code === 'ENOENT' && opts.cwd && !require('fs').existsSync(opts.cwd)) {
        const error = new Error(`The folder ${opts.cwd} does not exist (any more).`);
        error.code = 'NoSuchFolder';
        reject(error);
      } else if (e && e.code === 'ENOENT') {
        const error = new Error(`Git executable not found ("${gitPath}"). Install git or set "commitCorner.gitPath".`);
        error.code = 'GitNotFound';
        reject(error);
      } else reject(e);
    });

    child.on('close', (code) => {
      if (lease) lease.release();
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      const stdoutBuf = Buffer.concat(out);
      const stderr = Buffer.concat(err).toString('utf8');
      const exitCode = aborted ? null : truncated ? 0 : code;
      logger({ args, cwd: opts.cwd, ms: Date.now() - started, exitCode, stderr });
      const stdout = opts.buffer ? stdoutBuf : stdoutBuf.toString('utf8');
      if (timedOut) {
        reject(new GitError({ args, exitCode: -1, stdout: '', stderr, cwd: opts.cwd, timedOut: true }));
        return;
      }
      if (aborted) {
        reject(new GitError({ args, exitCode: null, stdout: '', stderr: 'Cancelled', cwd: opts.cwd }));
        return;
      }
      if (exitCode !== 0 && !opts.allowFailure) {
        reject(new GitError({ args, exitCode, stdout: opts.buffer ? '' : stdout, stderr, cwd: opts.cwd }));
        return;
      }
      resolve({ stdout, stderr, exitCode, truncated });
    });

    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/**
 * Make git's messages English (we classify errors by their text) without
 * changing anything else: LC_ALL would also switch character handling for
 * hooks and tools git runs on the user's behalf, so only LC_MESSAGES and
 * LANGUAGE change, and a user-set LC_ALL is turned into LANG.
 */
function englishMessages(env) {
  if (env.LC_ALL) {
    env.LANG = env.LC_ALL;
    delete env.LC_ALL;
  }
  env.LC_MESSAGES = 'C';
  env.LANGUAGE = 'C';
}

/** Spawn a long-running git process with the same environment rules as git(). */
function spawnGit(args, opts = {}) {
  const env = { ...inheritedEnv(), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...opts.env };
  englishMessages(env);
  return spawn(gitPath, ['-c', 'safe.bareRepository=explicit', '-c', 'core.quotepath=false', ...args], { cwd: opts.cwd, env, windowsHide: true });
}

let versionPromise;
/** @returns {Promise<{major:number, minor:number, patch:number, raw:string}>} */
function getVersion() {
  if (!versionPromise) {
    versionPromise = git(['--version']).then(({ stdout }) => parseVersion(stdout)).catch((e) => {
      versionPromise = undefined;
      throw e;
    });
  }
  return versionPromise;
}

function parseVersion(text) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!m) return { major: 0, minor: 0, patch: 0, raw: text.trim() };
  return { major: +m[1], minor: +m[2], patch: +(m[3] || 0), raw: text.trim() };
}

function versionAtLeast(v, major, minor) {
  return v.major > major || (v.major === major && v.minor >= minor);
}

module.exports = { getGitPath, englishMessages, spawnGit, git, configure, getVersion, parseVersion, versionAtLeast, GitError, ErrorCodes, classify, summarize };
