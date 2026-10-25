'use strict';

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/**
 * Credential prompts without a terminal. git (GIT_ASKPASS) and ssh
 * (SSH_ASKPASS) run a tiny helper script with the prompt text; the helper
 * forwards it over a private local socket to this server, which asks the
 * user (through the `prompt` callback) and sends the answer back.
 *
 * The socket lives in a fresh 0700 directory and every request must carry a
 * random token, so other local users or processes cannot ask questions. Each
 * network command gets a token of its own (lease()), valid only while it runs.
 * git and ssh use separate wrapper scripts, so a prompt is known to come from
 * ssh (whose prompt text a remote server can choose) or from git.
 */
class AskpassServer {
  /**
   * @param {(prompt: string, o: {quiet: boolean, ssh: boolean, lease: object}) => Promise<string|undefined>} prompt
   *        resolves undefined when cancelled; `quiet` requests come from background work and must not
   *        show UI; `ssh` ones come from ssh (or anything but git's own wrapper); `lease` is what the
   *        command's lease was given (lease(meta))
   * @param {string} scriptDir directory where the executable wrapper script is written
   */
  constructor(prompt, scriptDir) {
    this.prompt = prompt;
    this.scriptDir = scriptDir;
    /** Tokens of the commands running now -> what their lease was given. */
    this.tokens = new Map();
    this.queue = Promise.resolve();
  }

  async start() {
    this.socketDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'commit-corner-askpass-'));
    await fs.promises.chmod(this.socketDir, 0o700);
    this.socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\commit-corner-askpass-${crypto.randomBytes(8).toString('hex')}`
      : path.join(this.socketDir, 'socket');
    this.server = net.createServer((sock) => this.handle(sock));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, resolve);
    });
    // Never keep a process alive just for prompts.
    this.server.unref();
    await fs.promises.mkdir(this.scriptDir, { recursive: true });
    const main = path.join(__dirname, '..', '..', 'scripts', 'askpass-main.js');
    // Written at runtime so they are executable regardless of how the extension was unpacked.
    const write = async (name, kind) => {
      const file = path.join(this.scriptDir, name);
      await fs.promises.writeFile(file, `#!/bin/sh\nCOMMIT_CORNER_ASKPASS_KIND=${kind} ELECTRON_RUN_AS_NODE=1 exec "${escapeSh(process.execPath)}" "${escapeSh(main)}" "$@"\n`, { mode: 0o700 });
      await fs.promises.chmod(file, 0o700);
      return file;
    };
    this.script = await write('askpass.sh', 'git');
    this.sshScript = await write('askpass-ssh.sh', 'ssh');
  }

  /**
   * Environment variables that route the prompts of one git command (and the ssh it runs) to
   * this server, with a token that stops working on release().
   */
  lease(meta = {}) {
    const token = crypto.randomBytes(24).toString('hex');
    this.tokens.set(token, meta);
    return {
      env: {
        GIT_ASKPASS: this.script,
        SSH_ASKPASS: this.sshScript,
        // OpenSSH >= 8.4: use SSH_ASKPASS even without a display or terminal.
        SSH_ASKPASS_REQUIRE: 'force',
        COMMIT_CORNER_ASKPASS_HANDLE: this.socketPath,
        COMMIT_CORNER_ASKPASS_TOKEN: token,
      },
      release: () => this.tokens.delete(token),
    };
  }

  handle(sock) {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let req;
      try {
        req = JSON.parse(buf.slice(0, nl));
      } catch {
        sock.end(JSON.stringify({ ok: false }) + '\n');
        return;
      }
      if (!req || typeof req.token !== 'string' || !this.tokens.has(req.token) || typeof req.prompt !== 'string') {
        sock.end(JSON.stringify({ ok: false }) + '\n');
        return;
      }
      // One prompt at a time, in order.
      this.queue = this.queue.then(async () => {
        let answer;
        try {
          answer = await this.prompt(req.prompt, { quiet: req.quiet === true, ssh: req.kind !== 'git', lease: this.tokens.get(req.token) || {} });
        } catch {
          answer = undefined;
        }
        sock.end(JSON.stringify(answer === undefined ? { ok: false } : { ok: true, answer }) + '\n');
      });
    });
    sock.on('error', () => {});
  }

  dispose() {
    if (this.server) this.server.close();
    if (this.socketDir) fs.rmSync(this.socketDir, { recursive: true, force: true });
  }
}

function escapeSh(s) {
  return String(s).replace(/(["\\$`])/g, '\\$1');
}

module.exports = { AskpassServer };
