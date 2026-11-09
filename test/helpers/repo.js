'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { normalizePath } = require('../../src/git/pathUtil');

/** Isolated git environment: no user/system config leaks into tests. */
const ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

/** A new temporary folder, its path written as the extension writes paths (Windows: "c:\\…"). */
function makeTempDir(prefix = 'cc-test-') {
  return normalizePath(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))));
}

/**
 * Create a throwaway repository and helpers to script history in it.
 */
function createRepo() {
  const dir = makeTempDir();
  const home = makeTempDir('cc-home-');
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
  process.env.HOME = home;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.XDG_CONFIG_HOME = home;
  const run = (...args) => execFileSync('git', args, { cwd: dir, env: { ...ENV, HOME: home, XDG_CONFIG_HOME: home }, encoding: 'utf8' }).trim();
  run('init', '-q', '-b', 'main');
  let tick = 1700000000;
  const api = {
    dir,
    git: run,
    write(rel, content) {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    },
    read(rel) {
      return fs.readFileSync(path.join(dir, rel), 'utf8');
    },
    rm(rel) {
      fs.rmSync(path.join(dir, rel), { force: true });
    },
    /** Commit everything with a deterministic, increasing timestamp. Returns the sha. */
    commit(message, files) {
      if (files) for (const [k, v] of Object.entries(files)) v === null ? api.rm(k) : api.write(k, v);
      run('add', '-A');
      tick += 60;
      execFileSync('git', ['commit', '-q', '--allow-empty', '-m', message], {
        cwd: dir,
        env: { ...ENV, HOME: home, GIT_AUTHOR_DATE: `${tick} +0000`, GIT_COMMITTER_DATE: `${tick} +0000` },
      });
      return run('rev-parse', 'HEAD');
    },
    /**
     * Remove the repository and its home. Not blocking, with retries: on Windows a git process
     * still running there (a repository's batch reader stopping) keeps the folder in use until it
     * exits, and a blocking retry would keep it from ever being told to.
     */
    cleanup() {
      const rm = (p) => fs.promises.rm(p, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      return Promise.all([rm(dir), rm(home)]);
    },
  };
  return api;
}

module.exports = { createRepo, makeTempDir };
