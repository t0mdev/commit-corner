'use strict';

/**
 * The GitHub module (src/vscode/github/): its boundaries (the only HTTP, the only token
 * reader, a small public surface) and its behaviour with a stubbed transport.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createVscode, installVscodeMock } = require('./helpers/vscodeMock');

installVscodeMock(createVscode());
const github = require('../src/vscode/github');
const transport = require('../src/vscode/github/transport');
const auth = require('../src/vscode/github/auth');
const pulls = require('../src/vscode/github/pulls');

const SRC = path.join(__dirname, '..', 'src');
function sources(dir = SRC) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sources(p) : e.name.endsWith('.js') ? [p] : [];
  });
}
const rel = (p) => path.relative(path.join(__dirname, '..'), p).split(path.sep).join('/');

/** Replace transport.send and the session for one test; returns the requests made. */
function stub(t, respond, signedIn = true) {
  const authorization = signedIn ? 'Bearer tok' : undefined;
  const saved = { send: transport.send, apiAuthorization: auth.apiAuthorization };
  const calls = [];
  transport.send = async (p, o) => {
    calls.push({ path: p, ...o });
    if (!transport.allowed(p)) throw Object.assign(new Error(`Unexpected GitHub API path: ${p}`), { code: 'BadPath' });
    return respond(p, o);
  };
  auth.apiAuthorization = async () => authorization;
  pulls.reset();
  t.after(() => {
    Object.assign(transport, { send: saved.send });
    auth.apiAuthorization = saved.apiAuthorization;
    pulls.reset();
  });
  return calls;
}
const json = (body, headers = {}, status = 200) => ({ status, headers, text: JSON.stringify(body) });
const pr = (n, extra = {}) => ({ number: n, title: `PR ${n}`, state: 'open', user: { login: 'octo' }, head: { sha: 'a'.repeat(40), ref: 'f' }, base: { ref: 'main' }, html_url: `https://github.com/o/r/pull/${n}`, ...extra });

test('only transport.js makes HTTP requests', () => {
  const offenders = sources().filter((f) => {
    let text = fs.readFileSync(f, 'utf8');
    // git's fetch (a method, or a local helper running `git fetch`) is not the web fetch().
    text = text.replace(/\.fetch\(|async fetch\(/g, '');
    if (/\b(const|function) fetch\b/.test(text)) text = text.replace(/\bfetch\(/g, '');
    return /require\(['"](node:)?(https?|http2|tls|dgram)['"]\)|\bfetch\(|XMLHttpRequest|WebSocket/.test(text);
  }).map(rel);
  assert.deepEqual(offenders, ['src/vscode/github/transport.js']);
  // The one other socket user is the local askpass server (a Unix socket / named pipe).
  const net = sources().filter((f) => /require\(['"](node:)?net['"]\)/.test(fs.readFileSync(f, 'utf8'))).map(rel);
  assert.deepEqual(net, ['src/git/askpass.js']);
});

test('only auth.js reads the GitHub session token', () => {
  const readers = sources().filter((f) => /accessToken|authentication\.getSession/.test(fs.readFileSync(f, 'utf8'))).map(rel);
  assert.deepEqual(readers, ['src/vscode/github/auth.js']);
  const importers = sources().filter((f) => /require\(['"][./]*(github\/)?(auth|transport|pulls)['"]\)/.test(fs.readFileSync(f, 'utf8')) && !f.includes(`${path.sep}github${path.sep}`)).map(rel);
  assert.deepEqual(importers, [], 'the rest of the extension uses only github/index.js');
});

test('the public surface is small and named (no generic request function)', () => {
  assert.deepEqual(Object.keys(github).sort(), ['GitHubApiError', 'answerGitPrompt', 'enabled', 'gitCredentialConfig', 'isGitHubPrompt', 'listPullRequests', 'pullRequestStatus', 'register', 'slugOf']);
});

test('transport: api.github.com only, and only the listed endpoints', async () => {
  assert.equal(transport.HOST, 'api.github.com');
  const ok = [
    '/repos/o/r/pulls?state=all&sort=updated&direction=desc&per_page=50&page=1',
    '/repos/o/r/pulls/7/reviews?per_page=100&page=1',
    `/repos/o/r/commits/${'a'.repeat(40)}/check-runs?per_page=100&page=2`,
    `/repos/o/r/commits/${'a'.repeat(40)}/status`,
  ];
  for (const p of ok) assert.equal(transport.allowed(p), true, p);
  const bad = [
    '/user', '/repos/o/r/pulls', '/repos/../x/pulls/1/reviews?per_page=100&page=1', '/repos/o/../pulls/1/reviews?per_page=100&page=1', '/repos/o/r/pulls/7/reviews?per_page=100&page=9',
    '//evil.example/repos/o/r/pulls/1/reviews?per_page=100', '/repos/o/r/commits/HEAD/status', '/repos/o/r/pulls/1/reviews?per_page=100&x=1',
    'https://evil.example/repos/o/r/commits/' + 'a'.repeat(40) + '/status', 7, undefined,
  ];
  for (const p of bad) assert.equal(transport.allowed(p), false, String(p));
  await assert.rejects(transport.send('/user'), (e) => e.code === 'BadPath');
});

test('the token goes only into the Authorization header of allowed API requests', async (t) => {
  const calls = stub(t, () => json([pr(1)]));
  await github.listPullRequests('o', 'r', 'all', 5);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, 'Bearer tok');
  assert.match(calls[0].path, /^\/repos\/o\/r\/pulls\?state=all&/);
  // A strange owner name is encoded into a path the allowlist refuses: nothing is sent.
  await assert.rejects(github.listPullRequests('o/../../user', 'r'), (e) => e.code === 'BadPath');
});

test('signed out: requests go without Authorization', async (t) => {
  const calls = stub(t, () => json([]), false);
  await github.listPullRequests('o', 'r');
  assert.equal(calls[0].authorization, undefined);
});

test('answers only git\'s own github.com prompts, never ssh ones', async () => {
  const getSession = async () => ({ accessToken: 'gho_x', account: { label: 'octo' } });
  assert.equal(await github.answerGitPrompt("Password for 'https://octo@github.com': ", { getSession, helpersOff: true }), 'gho_x');
  assert.equal(await github.answerGitPrompt("Password for 'https://octo@github.com': ", { getSession, ssh: true, helpersOff: true }), undefined);
  for (const p of ["Password for 'https://github.com.evil.example': ", "Password for 'http://github.com': ", "(git@x) Password for 'https://github.com': ", "Password for 'https://github.com':\u0007 "]) {
    assert.equal(await github.answerGitPrompt(p, { getSession, helpersOff: true }), undefined, p);
  }
});

test('the token goes only to commands started with the credential helpers switched off', async () => {
  // Signing in while a push waits: that git has the helpers on and could store the token.
  const getSession = async () => ({ accessToken: 'gho_x', account: { label: 'octo' } });
  assert.equal(await github.answerGitPrompt("Password for 'https://github.com': ", { getSession }), undefined);
  assert.equal(await github.answerGitPrompt("Password for 'https://github.com': ", { getSession, helpersOff: false }), undefined);
  assert.equal(await github.answerGitPrompt("Password for 'https://github.com': ", { getSession, helpersOff: true }), 'gho_x');
});

test('ETag revalidation reuses the cached list; rate limits and errors are reported', async (t) => {
  let n = 0;
  const calls = stub(t, (p, o) => {
    n++;
    if (n === 1) return json([pr(1)], { etag: 'W/"1"' });
    if (n === 2) return { status: 304, headers: {}, text: '' };
    return json({ message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' }, 403);
  });
  assert.equal((await github.listPullRequests('o', 'r')).prs.length, 1);
  assert.equal((await github.listPullRequests('o', 'r')).prs[0].number, 1, '304 → cached body');
  assert.equal(calls[1].etag, 'W/"1"');
  await assert.rejects(github.listPullRequests('o', 'r'), (e) => e instanceof github.GitHubApiError && e.status === 403 && /rate limit/.test(e.message));
});

test('after a network failure the API is not asked again for a minute', async (t) => {
  const calls = stub(t, () => {
    throw new Error('getaddrinfo ENOTFOUND api.github.com');
  });
  await assert.rejects(github.listPullRequests('o', 'r'), /ENOTFOUND/);
  await assert.rejects(github.listPullRequests('o', 'r'), (e) => e.status === 0 && /retrying in a minute/.test(e.message));
  assert.equal(calls.length, 1);
});

test('API data is type-checked and narrowed before it leaves the module', async (t) => {
  stub(t, (p) => {
    if (p.includes('/pulls?')) {
      return json([
        pr(1, { title: { toString: () => 'x' }, user: { login: ['a'] }, labels: [{ name: 'ui' }, { name: 5 }, null], html_url: 'javascript:alert(1)', state: 'weird', secret: 'dropped' }),
        pr('2'),
        pr(3, { head: { sha: '--upload-pack=touch /tmp/x' } }),
      ]);
    }
    if (p.includes('/reviews') && p.endsWith('page=1')) return json([...Array(98).fill({ user: { login: 'carl' }, state: 'COMMENTED' }), { user: { login: 'ada' }, state: 'CHANGES_REQUESTED' }, { user: null, state: 'APPROVED' }]);
    // The latest review of a long discussion is on a later page.
    if (p.includes('/reviews')) return json([{ user: { login: 'ada' }, state: 'APPROVED' }, { user: { login: 'bob' }, state: 'CHANGES_REQUESTED' }]);
    if (p.includes('/check-runs')) return json({ check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }, { name: { x: 1 }, status: 'in_progress' }] });
    return json({ statuses: 'nope' });
  });
  const { prs } = await github.listPullRequests('o', 'r');
  assert.deepEqual(prs.map((p) => p.number), [1], 'malformed numbers and SHAs are dropped');
  assert.deepEqual([prs[0].title, prs[0].author, prs[0].labels, prs[0].url, prs[0].state, 'secret' in prs[0]], ['', '', ['ui'], '', 'open', false]);
  const st = await github.pullRequestStatus('o', 'r', 1, 'a'.repeat(40));
  assert.deepEqual(st, { approvedBy: ['ada'], changesRequestedBy: ['bob'], checks: [{ name: 'ci', state: 'success' }, { name: '', state: 'pending' }] });
  const noSha = await github.pullRequestStatus('o', 'r', 1, '--bad');
  assert.deepEqual(noSha.checks, [], 'no head SHA, no check requests');
});

test('slugOf accepts github.com repositories only', () => {
  assert.deepEqual(github.slugOf('https://github.com/octo/demo'), { owner: 'octo', repo: 'demo' });
  for (const u of ['https://github.com/../x', 'https://github.com/o/r/extra', 'https://gitlab.com/o/r', 'http://github.com/o/r', undefined]) assert.equal(github.slugOf(u), undefined, String(u));
});

test('signed in, git keeps the token from its credential helpers (github.com only)', async (t) => {
  // The lease's config reaches git as -c arguments (read by every git version).
  const exec = require('../src/git/exec');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cred-'));
  t.after(() => {
    exec.configure({ env: {} });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // Without the user's and the system's git config, whose helpers would be listed too.
  exec.configure({ env: () => ({ env: { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' }, release() {}, config: [['credential.https://github.com.helper', '']] }) });
  const { stdout } = await exec.git(['config', '--get-all', 'credential.https://github.com.helper'], { cwd: dir, network: true, allowFailure: true });
  assert.equal(stdout, '\n', 'an empty helper (which resets the list) for github.com');
});

test('prompt text from git or a server cannot become a link or an icon', () => {
  const { plainText } = require('../src/vscode/notify');
  const out = plainText("Password for [Fix](command:workbench.action.terminal.sendSequence?%7B%7D):\n$(check) ok");
  assert.doesNotMatch(out, /\]\(|\$\(|\n/);
  assert.equal(out.replace(/​/g, ''), 'Password for [Fix](command:workbench.action.terminal.sendSequence?%7B%7D): $(check) ok');
});
