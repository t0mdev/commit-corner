# Development policy and tooling

## Runtime: no dependencies, no network of its own

The packaged extension (`.vsix`) contains only `src/`, `media/`, the two helper
scripts git runs (`scripts/askpass-main.js`, `scripts/sequence-editor.js`),
the manifest, README, CHANGELOG and LICENSE (see `.vscodeignore`). It has no npm dependencies.
Its network traffic is the git commands you run; VS Code's own GitHub sign-in
(if `commitCorner.githubAuthentication` is on); and, as a deliberate
exception, **the GitHub REST API for pull request details**
(`src/vscode/github/`: GET requests to api.github.com only, with the
already-granted VS Code GitHub session when there is one, 15 s timeout, 5 MB
response cap, ETag revalidation; off with `commitCorner.pullRequests.githubApi`).
Diffs never depend on it.

A second deliberate exception: **language models, through VS Code's
Language Model API** (`src/vscode/ai/`, shown by `webviews/summaryPanel.js`),
for a generated commit message (✨) and summaries of changes (Changes vs Base,
pull requests, selected commits). The extension makes no HTTP request for it
and adds no dependency: VS Code hands the request to the model provider you
installed and signed in to (GitHub Copilot, or another extension providing
models), and asks you once whether Commit Corner may use it. The rules:

- Nothing is sent unless you ask (the ✨ button, a Summarize command); off with
  `commitCorner.ai.enabled`.
- Nothing is sent when the setting is off — a user (application) setting, so
  a workspace cannot turn it on or choose the model.
- What is sent is the diff you asked about (new, untracked files included, via a
  temporary index copy), fitted to the model's input size (`prompt.js`
  `fitPatch`: the `--stat` summary cut to a third of the budget, then file by
  file; a long file is cut, the files that do not fit are counted; git's output
  is capped at 4× the budget and stops on Cancel), plus for commits their
  messages, authors and dates, and for commit messages the branch name and the
  last 10 commit subjects. Lock, generated and binary files go by name only; so
  do files that may hold secrets under any of their names in the diff (renames,
  quoted paths; a name that cannot be read counts as secret): `.env*`, `.npmrc`,
  `.netrc`, `.pgpass`, credentials, `secrets.*`, service-account JSON, kube and
  docker configs, private keys, `*.pem`/`*.key`/`*.p12`/`*.tfvars`…. Well-known
  token formats, `password=`/`api_key:`-style values and private-key blocks are
  replaced by `[secret removed]` file by file (a key block ends where the key
  material ends). Best effort; summaries say what was withheld or removed.
- The diff is untrusted data: it goes inside a block with a random delimiter
  per request (closing tags in the data are defused), the commit subjects and
  branch name too, and the request says so. The answer is treated as
  untrusted as well. It only ever becomes text — the commit message box (you
  read it before committing) or the summary page, which renders a Markdown
  subset with DOM text nodes and runs nothing because of it.
- The model: the one `commitCorner.ai.modelFamily` names (family, id or the
  name Copilot's picker shows; Copilot's when several providers offer it), else
  Copilot's default, else any. Copilot CLI's models (vendor `copilotcli`) are
  never chosen: they fill Copilot CLI's model picker and answer other extensions
  with nothing. An empty answer is an error, never a blank page or message.
- The log (Output → Commit Corner, lines starting with `AI`) follows every
  request: at Info the model chosen and the others that matched, what was sent
  (files, cut, withheld, size) and how the answer came (characters, parts, the
  kinds of non-text parts, time, errors with their code); at Debug also the
  answer; at Trace also the request as sent (the diff after the secret removal).
  Log files stay on your machine, in VS Code's logs folder.

## Development: dev-only tooling

The rule is "no external libraries or web calls during build", with one
documented exception: development follows VS Code's official guidance, which
needs dev-only tooling and network access:

| Purpose | Package (exact version) | Guide |
|---|---|---|
| Run tests inside a real VS Code | `@vscode/test-cli` 0.0.15, `@vscode/test-electron` 3.1.0 (mocha comes with test-cli) | [Testing Extensions](https://code.visualstudio.com/api/working-with-extensions/testing-extension) |
| Package the `.vsix` | `@vscode/vsce` 4.0.0 | [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) |

Network access happens only in `npm ci`/`npm install` (the npm registry) and
in `npm run test:vscode` (VS Code builds from update.code.visualstudio.com,
cached in `.vscode-test/`). `npm run test:unit` and `npm run test:vscode:min`
(after its first download) run offline.

## Supply-chain rules

1. **Minimum age 4 weeks.** Every package version, including transitive ones,
   must have been published at least 4 weeks before it is installed. `.npmrc`
   sets `before=<date>`, so npm resolves everything as of that date. Raise the
   date deliberately (never to less than 4 weeks ago), reinstall, and review
   `package-lock.json` changes.
2. **Exact versions** (`save-exact=true`) and a committed `package-lock.json`;
   install with `npm ci`.
3. **Always audit**: `npm run audit` (`npm audit --audit-level=moderate`)
   after every install and before every release.
4. **Fix with overrides, within the age rule.** Vulnerable sub-dependencies are
   pinned to patched versions in `package.json` `overrides`, as long as the
   patched version is old enough.
5. **No install scripts** (`ignore-scripts=true` in `.npmrc`). The only
   dependency with one (`@vscode/vsce-sign`) copies a signing binary that
   packaging does not use. This project's own scripts still run with `npm run`.

### Current audit state (2026-10-25)

| Package | Finding | Status |
|---|---|---|
| `serialize-javascript` (via mocha 11, via test-cli) | GHSA-5c6j-r48x-rmvq, GHSA-qj8w-gfj5-8c6v (high) | **Fixed** by override to 7.1.1 |
| `diff` (via mocha 11) | GHSA-73rr-hh4g-fpgx (low) | **Fixed** by override to 8.0.4 |
| `serialize-javascript` 7.1.1 | GHSA-gfhx-hw2g-v5hg (low: XSS in serialized function bodies) | **Fixed** by override to 7.1.2 (published 2026-09-23; `before` raised to 2026-09-24 once it was 4 weeks old). |
| `@azure/msal-node` 6.0.1 (via `@vscode/vsce` → `@azure/identity`, publishing only) | GHSA-xcx6-jx8p-x3h5 (high) | **Waiting for the age rule**: the fix (7.1.0) is from 2026-10-13, usable from 2026-11-10. Not in the extension; only used when publishing to the Marketplace. |
| `serialize-javascript` 7.1.2 (via mocha) | GHSA-m5mm-p8h7-m29v (low) | **Waiting for the age rule**: the fix (7.1.3) is from 2026-10-22, usable from 2026-11-19. Test tooling only. |

As of 2026-10-25 `npm audit` reports these dev-only findings (2 high, 3 low entries for the two
packages above); `npm audit --omit=dev` reports 0. `npm run audit` (moderate or worse) fails until
the overrides above can be added.

## Security invariants

These hold everywhere and have tests (`test/regressions.test.js`):

- **Git is never given an option where a value belongs.** Arguments are
  arrays (no shell); revisions go through `checkRevs` (strings only, no
  leading `-`; refs that start with `-` are passed by full name); remote names
  through `checkRemotes`; paths are
  `:(literal)` after `--`; SHAs from webviews and command arguments must be
  hex (`validMessageShas`, `selectedShas`).
- **git runs only in repositories you opened or agreed to.** Workspace folders
  are trusted — by real path: a symlink in the workspace that leads elsewhere
  is outside — anything else asks first (`detectRepositoriesOfOpenFiles`,
  `openRepositoryInParentFolders`, both machine-scoped). A repository nested
  in an open one (an agent's worktree under `.claude/worktrees`, a cloned
  dependency) is a boundary: its files are not the outer repository's, and it
  is never staged, cleaned or discarded as a file — in every
  `untrackedFiles` mode: an untracked folder that "normal" would collapse is
  listed file by file when a `.git` lies anywhere below it
  (`expandFoldersHoldingRepositories`); inside the workspace it
  opens as a repository of its own when you open one of its files. git runs
  in a submodule or linked-worktree folder only after checking that its
  `.git` file points into our own `.git/modules` or `.git/worktrees`. A repository is only
  accepted through its own `.git` (`ownsGitDir`, checked right after
  `rev-parse`, which runs no configured programs); `safe.bareRepository=explicit`
  is set as a second line of defence (git 2.38+ honours it; older git ignores
  it, and `ownsGitDir` alone refuses embedded bare repositories); the
  rebase-todo editor and the `commitcorner:` file system only use open
  repositories.
- **A commit cannot forge another.** Log records end in NUL, or are framed by
  a random per-call nonce (`framedLog`) when more output follows each commit;
  git's own fields (SHAs, dates, refs) come before the text an author chose.
- **Repository and API text is data, never markup or links.** Webviews build
  DOM with text APIs under a nonce CSP; trusted tooltips escape every
  repository string; notifications go through `src/vscode/notify.js`, which
  breaks `[label](link)` syntax; `$(icon)` syntax is escaped where VS Code
  renders it from repository text.
- **Credentials stay with the command that needs them.** Only network commands
  get the askpass environment, with a per-command token; the GitHub session
  answers only git's anchored `https://github.com` prompts, never ssh's; the
  GitHub API is contacted at api.github.com only.
- **All GitHub.com access is one small module, `src/vscode/github/`**, meant
  to be reviewed in one sitting (`test/github.test.js` enforces the borders):
  - `index.js` — the whole public surface (`listPullRequests`,
    `pullRequestStatus`, `slugOf`, `enabled`, `answerGitPrompt`, the sign-in
    command); its header lists every endpoint and why. No generic request
    function is exported, and the rest of the extension imports nothing else.
  - `transport.js` — the only HTTP code in the extension: GET to
    api.github.com, endpoint allowlist, timeout, size cap, no redirects.
  - `auth.js` — VS Code's GitHub sign-in and the only code that reads the
    token: for the API `Authorization` header and for git's own
    `https://github.com` prompt, nothing else.
  - `pulls.js` — the calls, ETag cache, offline backoff, and type-checking of
    every response before it leaves the module.

## Tests

- `test/*.test.js` (node:test): parsers, line diff, graph layout, the git layer
  against real temporary repositories, the VS Code layer against an in-memory
  API mock, and the packaged `.vsix` (built with vsce).
- `test/integration/*.test.js` (mocha TDD, run by `vscode-test`): activation,
  contributed commands and views, native diff and multi-diff editors, the
  3-way merge editor (internal `_open.mergeEditor`), the index file system,
  the graph panel, the sidebar Graph view and Repository Activity, in VS Code
  1.140.0 (the `engines` minimum) and the latest stable, plus a third run on
  1.140.0 with the built-in Git switched off (`test/integration/replacement.test.js`:
  quick diff and count badge come from this extension). `.vscode-test.mjs`
  creates a fresh throwaway repository for each run.
- `test/ui/*.test.js` (mocha TDD, `npm run test:ui`, also part of `vscode-test`): the
  webviews' DOM in a real VS Code 1.143 — the graph's staging area (keys and focus, the
  commit message across reloads, ✨ with undo, Enter commits) and the summary page (the
  model's answer stays text). VS Code is started with a DevTools port and the tests read
  and drive the pages through it with Node's own WebSocket (`test/ui/cdp.js`); a test
  language model (`test/ui/fakelm`, canned answers, no network) is loaded as a second
  development extension. No extra dependency.
- `docs/SMOKE_TEST.md`: what still needs a human eye.

On Linux the VS Code windows need a display (WSLg or `xvfb-run`).
