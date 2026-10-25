'use strict';
/*
 * GIT_ASKPASS / SSH_ASKPASS helper. git and ssh run it with the prompt as
 * argument and read the answer from stdout. We forward the prompt to the
 * Commit Corner extension (src/git/askpass.js) over its private socket.
 * Exit code 1 means "cancelled".
 */
const net = require('net');

const handle = process.env.COMMIT_CORNER_ASKPASS_HANDLE;
const token = process.env.COMMIT_CORNER_ASKPASS_TOKEN;
const prompt = process.argv.slice(2).join(' ') || 'Password:';
if (!handle || !token) process.exit(1);

// Background git (auto-fetch) marks its prompts quiet: answered only without asking the user.
const quiet = process.env.COMMIT_CORNER_ASKPASS_QUIET === '1';
// Set by the wrapper script: "git" (GIT_ASKPASS) or "ssh" (SSH_ASKPASS).
const kind = process.env.COMMIT_CORNER_ASKPASS_KIND === 'git' ? 'git' : 'ssh';
const sock = net.connect(handle, () => sock.write(JSON.stringify({ token, prompt, quiet, kind }) + '\n'));
let buf = '';
sock.setEncoding('utf8');
sock.on('data', (d) => (buf += d));
sock.on('end', () => {
  try {
    const res = JSON.parse(buf.trim());
    if (res.ok) {
      process.stdout.write(`${res.answer}\n`);
      process.exit(0);
    }
  } catch { /* fall through */ }
  process.exit(1);
});
sock.on('error', () => process.exit(1));
