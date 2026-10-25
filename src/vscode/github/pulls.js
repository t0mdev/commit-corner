'use strict';

const transport = require('./transport');
const auth = require('./auth');
const { log } = require('../util');

/**
 * The pull request calls, on top of ./transport.js: ETag cache, offline backoff, errors, and
 * type-checking of everything that comes back (API data is someone else's text, and numbers
 * and SHAs end up in git refspecs). Only the fields the views use leave this file.
 */

/** path -> {etag, body, who} (who: which account asked, as a short hash) */
const cache = new Map();
/** Until when (ms) requests fail fast after a network error. */
let offlineUntil = 0;

class GitHubApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** GET a JSON resource: cached with ETags (a 304 does not count against the rate limit when signed in). */
async function get(path) {
  if (Date.now() < offlineUntil) throw new GitHubApiError(0, 'GitHub API not reachable (retrying in a minute)');
  const authorization = await auth.apiAuthorization();
  // Cached per account (a hash of the credential, never the credential itself).
  const who = authorization ? require('crypto').createHash('sha256').update(authorization).digest('hex').slice(0, 16) : '';
  const cached = cache.get(path);
  const etag = cached && cached.who === who ? cached.etag : undefined;
  let res;
  try {
    res = await transport.send(path, { authorization, etag });
  } catch (e) {
    // Offline: do not make every view wait on the network again for a minute.
    if (e.code !== 'BadPath') offlineUntil = Date.now() + 60e3;
    throw e;
  }
  if (res.status === 304 && cached) return cached.body;
  if (res.status !== 200) {
    let message = `GitHub API ${res.status}`;
    try {
      message = String(JSON.parse(res.text).message || message);
    } catch { /* not JSON */ }
    if (res.status === 403 && res.headers['x-ratelimit-remaining'] === '0') message = 'GitHub API rate limit reached; sign in to GitHub for a higher limit';
    throw new GitHubApiError(res.status, message);
  }
  const body = JSON.parse(res.text);
  if (res.headers.etag) {
    if (cache.size > 500) cache.clear();
    cache.set(path, { etag: res.headers.etag, body, who });
  }
  return body;
}

const repoPath = (owner, repo) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
const str = (v) => (typeof v === 'string' ? v : '');
const date = (v) => (typeof v === 'string' ? Date.parse(v) || 0 : 0);

/**
 * The fields of a pull request the views use (everything else is dropped), type-checked.
 * @returns {object|undefined} undefined for anything that is not a well-formed pull request
 */
function pullSummary(p) {
  if (!p || !Number.isSafeInteger(p.number) || p.number <= 0) return undefined;
  const sha = p.head && typeof p.head.sha === 'string' && /^[0-9a-f]{40,64}$/.test(p.head.sha) ? p.head.sha : undefined;
  const state = p.merged_at ? 'merged' : p.draft && p.state === 'open' ? 'draft' : p.state === 'closed' ? 'closed' : 'open';
  return {
    number: p.number,
    title: str(p.title),
    state,
    author: p.user ? str(p.user.login) : '',
    createdAt: date(p.created_at),
    updatedAt: date(p.updated_at),
    mergedAt: p.merged_at ? date(p.merged_at) : undefined,
    closedAt: p.closed_at ? date(p.closed_at) : undefined,
    headSha: sha,
    headRef: str(p.head && p.head.ref),
    headOwner: p.head && p.head.repo && p.head.repo.owner ? str(p.head.repo.owner.login) || undefined : undefined,
    baseRef: str(p.base && p.base.ref),
    labels: (Array.isArray(p.labels) ? p.labels : []).map((l) => str(l && l.name)).filter(Boolean),
    body: str(p.body),
    url: /^https:\/\/github\.com\//.test(str(p.html_url)) ? p.html_url : '',
  };
}

/**
 * Pull requests of a repository, most recently updated first: up to `limit`, page by page
 * (100 per page). `more` says whether there are further ones.
 * @param {'open'|'all'} state
 * @returns {Promise<{prs: object[], more: boolean}>}
 */
async function listPullRequests(owner, repo, state = 'all', limit = 50) {
  const perPage = Math.min(100, Math.max(1, limit));
  const out = [];
  let more = false;
  for (let page = 1; out.length < limit; page++) {
    const list = await get(`${repoPath(owner, repo)}/pulls?state=${state === 'open' ? 'open' : 'all'}&sort=updated&direction=desc&per_page=${perPage}&page=${page}`);
    if (!Array.isArray(list)) break;
    out.push(...list.map(pullSummary).filter((p) => p && p.headSha));
    more = list.length === perPage;
    if (!more) break;
  }
  return { prs: out.slice(0, limit), more: more || out.length > limit };
}

/**
 * Up to 5 pages of 100 (oldest first, as GitHub lists reviews): the latest review of each
 * reviewer is on the last page of a long discussion.
 * @param {(body: any) => any[]} items the list in a page's body
 */
async function pages(path, items) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const list = items(await get(`${path}${path.includes('?') ? '&' : '?'}page=${page}`));
    out.push(...list);
    if (list.length < 100) break;
  }
  return out;
}

/** Reviews (latest per reviewer) and CI checks of a pull request's head commit. */
async function pullRequestStatus(owner, repo, number, headSha) {
  const base = repoPath(owner, repo);
  const sha = typeof headSha === 'string' && /^[0-9a-f]{40,64}$/.test(headSha) ? headSha : undefined;
  const asList = (v) => (Array.isArray(v) ? v : []);
  const [reviews, checkRuns, status] = await Promise.all([
    pages(`${base}/pulls/${Number(number)}/reviews?per_page=100`, asList).catch((e) => (log().info(`PR reviews: ${e.message}`), [])),
    sha ? pages(`${base}/commits/${sha}/check-runs?per_page=100`, (b) => asList(b && b.check_runs)).catch(() => []) : [],
    sha ? get(`${base}/commits/${sha}/status`).catch(() => ({})) : {},
  ]);
  const runs = { check_runs: checkRuns };
  const latest = new Map();
  for (const r of Array.isArray(reviews) ? reviews : []) {
    const login = r && r.user ? str(r.user.login) : '';
    if (!login || r.state === 'COMMENTED' || r.state === 'PENDING') continue;
    latest.set(login, r.state);
  }
  const checks = [];
  for (const c of Array.isArray(runs && runs.check_runs) ? runs.check_runs : []) {
    checks.push({ name: str(c && c.name), state: c.status !== 'completed' ? 'pending' : ['success', 'neutral', 'skipped'].includes(c.conclusion) ? 'success' : 'failure' });
  }
  for (const s of Array.isArray(status && status.statuses) ? status.statuses : []) {
    checks.push({ name: str(s && s.context), state: s.state === 'success' ? 'success' : s.state === 'pending' ? 'pending' : 'failure' });
  }
  return {
    approvedBy: [...latest].filter(([, s]) => s === 'APPROVED').map(([u]) => u),
    changesRequestedBy: [...latest].filter(([, s]) => s === 'CHANGES_REQUESTED').map(([u]) => u),
    checks,
  };
}

/** For tests: forget cached responses and the offline backoff. */
function reset() {
  cache.clear();
  offlineUntil = 0;
}

module.exports = { listPullRequests, pullRequestStatus, pullSummary, GitHubApiError, reset };
