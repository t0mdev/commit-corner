'use strict';

/**
 * Turn a git remote URL into a github.com web base URL. Purely string based:
 * no network access. Returns undefined for anything that is not github.com
 * (Commit Corner supports GitHub.com only).
 *
 * Handles https://github.com/o/r(.git), git@github.com:o/r(.git),
 * ssh://git@github.com/o/r(.git) and ssh.github.com (port 443).
 */
/** SSH host aliases that mean github.com (commitCorner.githubHostAliases, e.g. "github-work"). */
let hostAliases = [];
function setGithubHostAliases(list) {
  hostAliases = (Array.isArray(list) ? list : []).filter((h) => typeof h === 'string' && /^[A-Za-z0-9._-]+$/.test(h)).map((h) => h.toLowerCase());
}

function githubWebUrl(remoteUrl) {
  if (!remoteUrl) return undefined;
  const hosts = ['github.com'];
  let host;
  let path;
  let m = /^(?:https?|git|ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(remoteUrl);
  if (m) {
    host = m[1];
    path = m[2];
  } else {
    // scp-like "[user@]host:path", read the way git does: the host is what comes before the
    // first ":" ("evil.example:x@github.com:o/r" is evil.example, not github.com).
    m = /^(?:[^@:/]+@)?([^:/@]+):(.+)$/.exec(remoteUrl);
    if (!m) return undefined;
    host = m[1];
    path = m[2];
  }
  host = host.toLowerCase();
  if (host === 'ssh.github.com' || hostAliases.includes(host)) host = 'github.com';
  if (!hosts.includes(host)) return undefined;
  path = path.replace(/\.git$/, '').replace(/\/+$/, '');
  if (!/^[^/]+\/[^/]+$/.test(path)) return undefined;
  return `https://${host}/${path}`;
}

/** Percent-encode each path segment but keep the slashes. */
function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

function githubFileUrl(base, sha, filePath, startLine, endLine) {
  let url = `${base}/blob/${sha}/${encodePath(filePath)}`;
  if (startLine) url += endLine && endLine !== startLine ? `#L${startLine}-L${endLine}` : `#L${startLine}`;
  return url;
}


/** Web URL of a commit on GitHub. */
function githubCommitUrl(base, sha) {
  return `${base}/commit/${sha}`;
}

/** Web URL of a pull request on GitHub. */
function githubPullUrl(base, number) {
  return `${base}/pull/${number}`;
}

/**
 * GitHub's "Open a pull request" page: compare `head` against `baseBranch` of the repository at
 * `base`. A head in another repository (a fork) is written "owner:branch".
 * @param {string} base web URL of the repository that receives the pull request
 * @param {string} baseBranch
 * @param {string} headBranch
 * @param {string} [headBase] web URL of the head's repository, when it differs from `base`
 */
function githubCompareUrl(base, baseBranch, headBranch, headBase) {
  const owner = headBase && headBase !== base ? `${encodeURIComponent(headBase.split('/')[3])}:` : '';
  return `${base}/compare/${encodePath(baseBranch)}...${owner}${encodePath(headBranch)}?expand=1`;
}

/** "#123" a commit subject names: a squash merge "… (#123)" or GitHub's "Merge pull request #123 …". */
function pullRequestOfSubject(subject) {
  const m = /\(#(\d+)\)\s*$/.exec(subject || '') || /^Merge pull request #(\d+)\b/.exec(subject || '');
  const n = m && Number(m[1]);
  return n && Number.isSafeInteger(n) ? n : undefined;
}

module.exports = { setGithubHostAliases, pullRequestOfSubject, githubWebUrl, githubFileUrl, githubCommitUrl, githubPullUrl, githubCompareUrl, encodePath };
