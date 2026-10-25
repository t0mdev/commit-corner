'use strict';

const https = require('https');

/**
 * The only HTTP code in the extension: a GET to api.github.com. Nothing else
 * in src/ makes network requests of its own (test/github.test.js checks that).
 *
 * - Host fixed to api.github.com, HTTPS, GET only, no redirects followed.
 * - Path must match one of ENDPOINTS (the calls listed in ./index.js).
 * - 15 s timeout, 5 MB response cap.
 * - `authorization` comes from ./auth.js and goes nowhere but this header.
 */

const HOST = 'api.github.com';
const MAX_BYTES = 5 * 1024 * 1024;

const NAME = '(?!\\.{1,2}/)[A-Za-z0-9_.-]+';
const SHA = '[0-9a-f]{40,64}';
/** Every path the extension may request (see ./index.js for what each is for). */
const ENDPOINTS = [
  new RegExp(`^/repos/${NAME}/${NAME}/pulls\\?state=(open|all)&sort=updated&direction=desc&per_page=\\d{1,3}&page=\\d{1,4}$`),
  new RegExp(`^/repos/${NAME}/${NAME}/pulls/\\d{1,9}/reviews\\?per_page=100&page=[1-5]$`),
  new RegExp(`^/repos/${NAME}/${NAME}/commits/${SHA}/check-runs\\?per_page=100&page=[1-5]$`),
  new RegExp(`^/repos/${NAME}/${NAME}/commits/${SHA}/status$`),
];

function allowed(path) {
  return typeof path === 'string' && ENDPOINTS.some((re) => re.test(path));
}

/**
 * @param {string} path one of ENDPOINTS
 * @param {{authorization?: string, etag?: string, signal?: AbortSignal, timeoutMs?: number}} [o]
 * @returns {Promise<{status: number, headers: object, text: string}>}
 */
function send(path, o = {}) {
  if (!allowed(path)) {
    const e = new Error(`Unexpected GitHub API path: ${path}`);
    e.code = 'BadPath';
    return Promise.reject(e);
  }
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'commit-corner-vscode',
  };
  if (o.authorization) headers.Authorization = o.authorization;
  if (o.etag) headers['If-None-Match'] = o.etag;
  return new Promise((resolve, reject) => {
    const req = https.request({ host: HOST, path, method: 'GET', headers, timeout: o.timeoutMs || 15000, signal: o.signal }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) req.destroy(new Error('GitHub API response too large'));
        else chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('GitHub API request timed out')));
    req.on('error', reject);
    req.end();
  });
}

module.exports = { send, allowed, HOST };
