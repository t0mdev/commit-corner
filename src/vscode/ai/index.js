'use strict';

const vscode = require('vscode');
const { config, log, redact } = require('../util');
const notify = require('../notify');
const { INDEX, EMPTY_TREE } = require('../../git/repository');
const { GitError, ErrorCodes } = require('../../git/exec');
const P = require('./prompt');

/**
 * Language models: generated commit messages and summaries of changes. A deliberate exception
 * to "no network of its own", like the GitHub API; see docs/DEVELOPMENT.md. Review these files together:
 *
 *   index.js   this file: choosing a model, asking it, the commands' data
 *   prompt.js  exactly what is sent (instructions + the diff, fitted to the model)
 *   ../webviews/summaryPanel.js + media/summary.js   answers shown as text, never as HTML
 *
 * Only through VS Code's Language Model API (vscode.lm): the model provider you installed and
 * signed in to (GitHub Copilot, …) answers. No HTTP request is made here and nothing is added
 * to the dependencies. VS Code asks you once whether Commit Corner may use a model, and nothing
 * is sent unless you ask (✨ Generate, Summarize). What is sent: the diff of what you asked
 * about, fitted to the model's input size, and for a commit message the branch name and the
 * last 10 commit subjects (for their style). Off: "commitCorner.ai.enabled": false.
 *
 * Answers are untrusted text (the diff may contain instructions meant for the model): they go
 * into the message box or a text-only page, and nothing runs because of them.
 *
 * The log (Output → Commit Corner) follows every request: at Info the model chosen (and the
 * others that matched), how much was sent, and how the answer came (its length, its parts,
 * the time); at Debug also the answer; at Trace also the request as sent. Lines start with "AI".
 */

class AiUnavailable extends Error {
  /** @param {{chooseModel?: boolean}} [o] chooseModel: another model may help (offer to pick one) */
  constructor(message, o = {}) {
    super(message);
    this.chooseModel = !!o.chooseModel;
  }
}

/**
 * Vendors whose models only fill another tool's model picker and answer nothing when another
 * extension asks: Copilot CLI's (listed under the same families as Copilot's own). Never chosen.
 */
const SILENT_VENDORS = new Set(['copilotcli']);

/** A provider's text on one log line (a name cannot start a line of its own). */
const one = (x) => String(x).replace(/[\r\n]+/g, ' ');

/** A model for the log: its provider and id, family, name and input size. */
function describeModel(m) {
  return one(`${m.vendor}/${m.id} (family ${m.family}${m.name && m.name !== m.id ? `, "${m.name}"` : ''}${m.version ? `, version ${m.version}` : ''}, ${m.maxInputTokens} input tokens)`);
}

/** A model for the page: its name, and who provides it when that is not Copilot. */
function modelLabel(m) {
  return `${m.name || m.family || m.id}${m.vendor && m.vendor !== 'copilot' ? ` (${m.vendor})` : ''}`;
}

/**
 * An error for the log: git's command, exit code and words; a model's error with its code and
 * cause; the stack only for anything else (a bug).
 */
function errorDetail(e) {
  if (!e || typeof e !== 'object') return String(e);
  if (e instanceof GitError) {
    const said = String(e.stderr || e.stdout || '').trim().split('\n').slice(0, 8).join('\n');
    return redact(`git ${e.args.join(' ').slice(0, 300)} → exit ${e.exitCode}${e.cwd ? ` in ${e.cwd}` : ''}${said ? `:\n${said}` : ''}`);
  }
  const cause = e.cause ? ` (cause: ${e.cause.message || e.cause})` : '';
  const known = (vscode.LanguageModelError && e instanceof vscode.LanguageModelError) || e instanceof AiUnavailable;
  return `${e.name || 'Error'}${e.code ? ` [${e.code}]` : ''}: ${e.message}${cause}${!known && e.stack ? `\n${e.stack}` : ''}`;
}

/** An error once logged here (the summary page does not log it again). */
function logged(e) {
  if (e && typeof e === 'object') e.logged = true;
  return e;
}

/** Stopped by you: git cancelled, or the request (the provider's cancellation error). */
function stopped(e, token) {
  return !!(token && token.isCancellationRequested) || (e instanceof GitError && e.code === ErrorCodes.Cancelled);
}

/** The reason nothing can be asked, logged under the request it belongs to. */
function unavailable(what, message, o) {
  log().warn(`AI ${what}: ${message}`);
  return logged(new AiUnavailable(message, o));
}

/** The model providers' versions, once per session (a provider's update can change what answers). */
let providersLogged = false;
function logProviders() {
  if (providersLogged) return;
  providersLogged = true;
  const known = ['GitHub.copilot-chat', 'GitHub.copilot'].map((id) => vscode.extensions && vscode.extensions.getExtension(id)).filter(Boolean);
  log().info(`AI: model providers: ${known.map((x) => `${x.id} ${x.packageJSON && x.packageJSON.version}`).join(', ') || 'no GitHub Copilot extension'} (VS Code ${vscode.version})`);
}

function enabled() {
  return config().get('ai.enabled', true) !== false;
}

/** Models that answer, Copilot's first (the order otherwise as VS Code gives it). */
function usable(models) {
  return models.filter((m) => !SILENT_VENDORS.has(m.vendor)).sort((a, b) => (b.vendor === 'copilot') - (a.vendor === 'copilot'));
}

/**
 * The models `wanted` names: by family, id or name (as Copilot's model picker shows it), or as
 * provider/id (as the log shows it, for one model that several providers offer), any case.
 */
function matching(models, wanted) {
  const w = wanted.toLowerCase();
  return models.filter((m) => [m.family, m.id, m.name, `${m.vendor}/${m.id}`].some((x) => String(x || '').toLowerCase() === w));
}

/** Every model, for the log: provider/id (family). */
const listModels = (models) => one(models.map((m) => `${m.vendor}/${m.id} (family ${m.family})`).join(', ') || 'none');

/**
 * The model to ask: the one "commitCorner.ai.modelFamily" names (family, id or name), else
 * Copilot's default, else any. `note` says when the setting's model was not available.
 * @param {string} [what] the request, for the log
 * @returns {Promise<{model: vscode.LanguageModelChat, note?: string}>}
 */
async function chooseModel(what = 'request') {
  if (!enabled()) throw unavailable(what, 'Generated messages and summaries are off (setting "commitCorner.ai.enabled").');
  if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') throw unavailable(what, 'This version of VS Code has no language model API.');
  logProviders();
  const wanted = String(config().get('ai.modelFamily', '') || '').trim();
  let models = [];
  let note;
  if (wanted) {
    const all = await vscode.lm.selectChatModels();
    const named = matching(all, wanted);
    models = usable(named);
    if (!models.length) {
      note = `"${wanted}" from the setting commitCorner.ai.modelFamily is ${named.length ? 'only offered by a provider that does not answer extensions' : 'not available'}`;
      log().warn(`AI ${what}: the model ${one(note)}; using the default instead. Available: ${listModels(all)}`);
    }
  }
  if (!models.length) models = usable(await vscode.lm.selectChatModels({ vendor: 'copilot' }));
  if (!models.length) {
    const all = await vscode.lm.selectChatModels();
    models = usable(all);
    if (!models.length) {
      throw unavailable(what, `No language model is available${all.length ? ` that answers extensions (found only: ${listModels(all)})` : ''}. Install GitHub Copilot Chat (or another extension that provides language models) and sign in.`);
    }
  }
  log().info(`AI ${what}: using ${describeModel(models[0])}`);
  const others = models.slice(1, 8).map((m) => `${m.vendor}/${m.id}`).join(', ');
  if (others) log().debug(`AI ${what}: also matched: ${others}${models.length > 8 ? ', …' : ''}`);
  return { model: models[0], note };
}

/**
 * The setting's value that chooses `m`: its family when that finds it first, else its id, else
 * its name, else provider/id (the same model under several providers).
 */
function settingFor(m, models) {
  for (const value of [m.family, m.id, m.name]) if (value && usable(matching(models, value))[0] === m) return value;
  return `${m.vendor}/${m.id}`;
}

/**
 * "Choose Language Model…": every model that answers, the choice stored in your user settings.
 * @returns {Promise<boolean>} whether the setting changed
 */
async function pickModel() {
  if (!enabled()) {
    notify.warn('Generated messages and summaries are off (setting "commitCorner.ai.enabled").');
    return false;
  }
  if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') {
    notify.warn('This version of VS Code has no language model API.');
    return false;
  }
  const all = await vscode.lm.selectChatModels();
  const models = usable(all);
  log().info(`AI: models offered: ${listModels(all)}`);
  if (!models.length) {
    notify.warn('No language model is available. Install GitHub Copilot Chat (or another extension that provides language models) and sign in.');
    return false;
  }
  const current = String(config().get('ai.modelFamily', '') || '').trim();
  // The model in use: the one the setting finds (written by hand, too), else the default.
  const inUse = current ? usable(matching(all, current))[0] : undefined;
  const check = (on) => (on ? '$(check) ' : '');
  const items = [
    { label: `${check(!inUse)}Default`, description: "Copilot's default model, else any", value: '' },
    // Names come from the providers: no $(icons) from them.
    ...models.map((m) => ({ label: `${check(m === inUse)}${notify.plainText(m.name || m.id)}`, description: notify.plainText(`${m.vendor} · ${m.family}`), detail: m.maxInputTokens ? `${Math.round(m.maxInputTokens / 1000)}k input tokens` : undefined, value: settingFor(m, all) })),
  ];
  const pick = await vscode.window.showQuickPick(items, { title: 'Language Model for Commit Messages and Summaries', placeHolder: 'Stored in your user settings (commitCorner.ai.modelFamily)', matchOnDescription: true });
  if (!pick || pick.value === current) return false;
  await config().update('ai.modelFamily', pick.value || undefined, vscode.ConfigurationTarget.Global);
  log().info(`AI: model set to ${pick.value ? `"${one(pick.value)}"` : 'the default'}`);
  return true;
}

/** An AiUnavailable as a warning, with the way to another model and to the log (not awaited by callers). */
async function warn(e) {
  try {
    const choice = await notify.warn(e.message, ...(e.chooseModel ? ['Choose Model…'] : []), 'Show Log');
    if (choice === 'Show Log') log().show(true);
    else if (choice === 'Choose Model…') await vscode.commands.executeCommand('commitCorner.ai.chooseModel');
  } catch (err) {
    log().warn(`AI: ${errorDetail(err)}`);
  }
}

/**
 * Whether new files' content may be sent: your own settings only (commitCorner.ai.includeUntracked
 * and untrackedFiles in user settings) — a workspace's settings cannot widen what leaves.
 */
function sendUntracked(repo) {
  const c = config();
  const include = c.inspect ? c.inspect('ai.includeUntracked') : undefined;
  const mode = c.inspect ? c.inspect('untrackedFiles') : undefined;
  const on = include && include.globalValue !== undefined ? include.globalValue : true;
  // "no" may come from anywhere (it only narrows what is sent); "on" only from you.
  return on !== false && !(mode && mode.globalValue === 'no') && !(repo && repo.untrackedMode === 'no');
}

/** Characters of changes that fit: about 3 per token, with room for the instructions and the answer. */
function budgetFor(model) {
  const tokens = Number(model.maxInputTokens) || 8000;
  return Math.max(6000, Math.min(400000, Math.floor((tokens - 2000) * 3)));
}

/** git's output is cut at 4 characters per character of budget: enough to fit, never unbounded. */
const bytesFor = (budget) => budget * 4;

/** An AbortSignal that follows a cancellation token (git stops when you press Stop). */
function signalOf(token) {
  const c = new AbortController();
  if (token) {
    if (token.isCancellationRequested) c.abort();
    else token.onCancellationRequested(() => c.abort());
  }
  return c.signal;
}

/** Language model errors in words a user can act on (the error itself is logged). */
function friendly(e, model) {
  const E = vscode.LanguageModelError;
  if (E && e instanceof E) {
    if (e.code === E.NoPermissions().code) return logged(new AiUnavailable('Commit Corner may not use language models. Allow it when VS Code asks, or under Accounts → Manage Language Model Access.'));
    if (e.code === E.NotFound().code) return logged(new AiUnavailable(`${modelLabel(model)} is not available any more.`, { chooseModel: true }));
    if (e.code === E.Blocked().code) return logged(new AiUnavailable(`${modelLabel(model)} did not answer (blocked or rate-limited): ${e.message}`, { chooseModel: true }));
    // Any other refusal (unsupported, no choices…): the model's words, and the way to another.
    return logged(new AiUnavailable(`${modelLabel(model)} failed: ${e.message}${e.code ? ` (${e.code})` : ''}`, { chooseModel: true }));
  }
  return logged(e);
}

/** Parts of an answer that are not text, in words (class names are minified in VS Code). */
const PART_KINDS = [['LanguageModelToolCallPart', 'tool call'], ['LanguageModelThinkingPart', 'thinking'], ['LanguageModelDataPart', 'data'], ['LanguageModelToolResultPart', 'tool result'], ['LanguageModelPromptTsxPart', 'prompt']];

/** What a part of the answer that is not text is (a tool call, thinking…), for the log and the error. */
function kindOf(part) {
  for (const [cls, word] of PART_KINDS) if (typeof vscode[cls] === 'function' && part instanceof vscode[cls]) return word;
  return 'other';
}

/** The answer in the log (Debug): long ones cut. */
const LOGGED_ANSWER = 20000;

/** A model still silent after this long is said in the log (and again every time it passes). */
const WAITING_MS = 30000;

/**
 * Ask the model. `onText(all)` gets the answer so far while it arrives.
 * @param {string} what the request, for the log
 * @returns {Promise<string>} the whole answer (what arrived, if cancelled)
 */
async function ask(model, prompt, token, onText, what = 'request') {
  const name = one(`${model.vendor}/${model.id}`);
  // Stopped (or the page closed) while the changes were read: nothing is sent.
  if (token && token.isCancellationRequested) {
    log().info(`AI ${what}: stopped before anything was sent`);
    return '';
  }
  log().info(`AI ${what}: sending ${prompt.length} characters to ${name}`);
  log().trace(`AI ${what}: the request as sent:\n${prompt}`);
  const started = Date.now();
  let res;
  try {
    res = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(prompt)],
      { justification: 'Commit Corner describes changes you asked about: a commit message or a review summary.' },
      token,
    );
  } catch (e) {
    if (stopped(e, token)) {
      log().info(`AI ${what}: stopped before ${name} answered`);
      return '';
    }
    log().error(`AI ${what}: ${name} did not take the request: ${errorDetail(e)}`);
    throw friendly(e, model);
  }
  let all = '';
  let parts = 0;
  let first;
  // A model that takes long (or hangs) is told from a stuck extension by the log.
  const waiting = setInterval(() => log().info(`AI ${what}: still waiting for ${name} after ${Math.round((Date.now() - started) / 1000)} s (${all.length} characters so far)`), WAITING_MS);
  /** Parts that are not text, by kind: what came instead when no text does. */
  const skipped = new Map();
  try {
    // The stream shows every part (`text` would hide the ones that are not text); text parts are
    // what `text` gives.
    const T = vscode.LanguageModelTextPart;
    if (res.stream && T) {
      for await (const part of res.stream) {
        if (!parts++) first = Date.now() - started;
        if (part instanceof T) {
          all += part.value;
          if (onText) onText(all);
        } else skipped.set(kindOf(part), (skipped.get(kindOf(part)) || 0) + 1);
      }
    } else {
      for await (const chunk of res.text) {
        if (!parts++) first = Date.now() - started;
        all += chunk;
        if (onText) onText(all);
      }
    }
  } catch (e) {
    if (stopped(e, token)) {
      log().info(`AI ${what}: stopped after ${all.length} characters`);
      return all;
    }
    log().error(`AI ${what}: the answer from ${name} broke off after ${all.length} characters (${Date.now() - started} ms): ${errorDetail(e)}`);
    throw friendly(e, model);
  } finally {
    clearInterval(waiting);
  }
  const halted = !!(token && token.isCancellationRequested);
  const other = [...skipped].map(([k, n]) => `${n} × ${k}`).join(', ');
  log().info(`AI ${what}: ${halted ? 'stopped; ' : ''}${name} answered ${all.length} characters in ${parts} part${parts === 1 ? '' : 's'} after ${Date.now() - started} ms${first !== undefined ? ` (the first after ${first} ms)` : ''}${other ? ` (not text: ${other})` : ''}`);
  if (all) log().debug(`AI ${what}: the answer:\n${all.length > LOGGED_ANSWER ? `${all.slice(0, LOGGED_ANSWER)}\n… (${all.length - LOGGED_ANSWER} more characters)` : all}`);
  if (!all.trim() && !halted) {
    throw unavailable(what, `${modelLabel(model)} sent an empty answer${other ? ` (only ${other})` : ''}. Choose another model, or see Output → Commit Corner for details.`, { chooseModel: true });
  }
  return all;
}

/**
 * A commit message for what Commit would commit: the staged changes, or (nothing staged)
 * all changes, as smart commit stages them.
 * @param {import('../../git/repository').Repository} repo
 * @param {{token?: vscode.CancellationToken, onText?: (text: string) => void}} [o]
 */
async function commitMessage(repo, o = {}) {
  const what = 'commit message';
  const { model, note } = await chooseModel(what);
  if (note) tellOnce(note, model);
  const s = await repo.refreshState();
  const from = s.head.sha || EMPTY_TREE;
  const staged = s.staged.length > 0;
  if (!staged && !s.unstaged.length && !s.untracked.length) throw unavailable(what, 'Nothing to describe: there are no changes.');
  const budget = budgetFor(model);
  // Nothing staged: what smart commit would stage, new files included (with their content).
  // New files only where you show them (untrackedFiles "no": you chose not to see them).
  let patch;
  try {
    patch = await repo.patchText(from, staged ? INDEX : undefined, { withUntracked: !staged && sendUntracked(repo), maxBytes: bytesFor(budget), signal: signalOf(o.token) });
  } catch (e) {
    if (stopped(e, o.token)) {
      log().info(`AI ${what}: stopped while reading the changes`);
      return '';
    }
    log().error(`AI ${what}: reading the changes failed: ${errorDetail(e)}`);
    throw logged(e);
  }
  // This branch's own recent subjects (not every branch's and tag's), each at most 200 characters.
  const subjects = s.head.sha ? (await repo.log({ revs: ['HEAD'], maxCount: 10 }).catch((e) => (log().debug(`AI ${what}: no recent subjects for the style: ${errorDetail(e)}`), []))).map((c) => String(c.subject).slice(0, 200)) : [];
  const fitted = P.fitPatch(patch, budget);
  log().info(`AI ${what}: ${staged ? 'the staged changes' : 'all changes'}: ${fitted.files} file${fitted.files === 1 ? '' : 's'}${fitted.cut ? `, ${fitted.cut} shortened or left out` : ''}${fitted.withheld ? `, ${fitted.withheld} by name only` : ''}${fitted.secrets ? `, ${fitted.secrets} secret-looking values removed` : ''} (budget ${budget} characters)`);
  // Commit subjects can hold a secret too (a pasted token): the same removal as the diff.
  const clean = (t) => P.redactSecrets(t).text;
  const prompt = P.commitMessagePrompt({ patch: fitted.text, subjects: subjects.map(clean), branch: s.head.branch ? clean(s.head.branch) : undefined });
  const text = await ask(model, prompt, o.token, o.onText && ((t) => o.onText(P.cleanMessage(t))), what);
  const message = P.cleanMessage(text);
  if (text.trim() && !message && !(o.token && o.token.isCancellationRequested)) throw unavailable(what, `${modelLabel(model)} answered without a commit message in it. Choose another model, or see Output → Commit Corner for the answer (log level Debug).`, { chooseModel: true });
  return message;
}

/** Settings already said to be unavailable this session (✨ has no page to say it on). */
const told = new Set();
function tellOnce(note, model) {
  if (told.has(note)) return;
  told.add(note);
  notify.info(`The language model ${note}: ${modelLabel(model)} writes the message instead.`, 'Choose Model…').then((c) => c && vscode.commands.executeCommand('commitCorner.ai.chooseModel'), (e) => log().warn(`AI: ${errorDetail(e)}`));
}

/**
 * The changes a summary is about, as a fitted patch.
 * @typedef {{key?: string, title: string, what: string, patch: (budget: number, signal?: AbortSignal) => Promise<{text: string, files: number, cut: number, secrets: number, withheld: number}>}} SummarySource
 */

/** A worktree's work since it left its base (committed and uncommitted, like Changes vs Base). */
function worktreeSource(repo, worktreePath, name, base) {
  return {
    key: `${repo.root}\0worktree\0${worktreePath}\0${base}`, // one page per repository and subject
    title: `${name} vs ${base}`,
    // The names are the agent's: kept to plain characters in the instructions.
    what: `the changes in a worktree (${plain(name)}) since it left ${plain(base)} (committed and uncommitted)`,
    patch: async (budget, signal) => {
      const { mergeBase } = await repo.worktreeChangesSince(worktreePath, base);
      // New files the agent has not added yet are part of its work: in the patch, as added.
      return P.fitPatch(await repo.patchText(mergeBase, undefined, { cwd: worktreePath, withUntracked: sendUntracked(repo), maxBytes: bytesFor(budget), signal }), budget);
    },
  };
}

/** A name for the instruction text: letters, digits and . / _ - only, at most 60 characters. */
function plain(name) {
  return String(name).replace(/[^\w./-]/g, '_').slice(0, 60);
}

/** A pull request: what it changes since its merge base (GitHub's "Files changed"). */
function pullRequestSource(repo, number, mergeBase, headSha) {
  return {
    key: `${repo.root}\0pr\0${number}`,
    title: `PR #${number}`,
    what: `the changes of pull request #${number}`,
    patch: async (budget, signal) => P.fitPatch(await repo.patchText(mergeBase, headSha, { maxBytes: bytesFor(budget), signal }), budget),
  };
}

/** Commits, each with its message and patch (oldest first), sharing the budget. */
function commitsSource(repo, shas) {
  const list = shas.slice(0, 30);
  return {
    key: `${repo.root}\0commits\0${list.join(',')}`,
    title: list.length === 1 ? `commit ${list[0].slice(0, 7)}` : `${list.length} commits (${list.slice(0, 3).map((x) => x.slice(0, 7)).join(', ')}${list.length > 3 ? ', …' : ''})`,
    what: list.length === 1 ? 'the changes of this commit' : `the changes of these ${list.length} commits${shas.length > list.length ? ` (the first ${list.length} of ${shas.length} selected)` : ''}`,
    patch: async (budget, signal) => {
      const each = Math.floor(budget / list.length);
      const sum = { files: 0, cut: 0, secrets: 0, withheld: 0 };
      const parts = [];
      for (const sha of await repo.sortTopologically(list)) {
        const fitted = P.fitPatch(await repo.commitPatchText(sha, { maxBytes: bytesFor(each), signal }), each);
        for (const k of Object.keys(sum)) sum[k] += fitted[k];
        parts.push(fitted.text);
      }
      return { text: parts.join('\n\n'), ...sum };
    },
  };
}

/**
 * Summarize: the model's answer, as it arrives, through `onText`; `onModel(label)` once the model is chosen.
 * @param {SummarySource} source
 * @param {{token?: vscode.CancellationToken, onText?: (text: string) => void, onModel?: (label: string, note?: string) => void}} [o]
 * @returns {Promise<{text: string, model: string, note?: string, files: number, cut: number, secrets: number, withheld: number}>}
 */
async function summarize(source, o = {}) {
  const what = `summary of ${source.title}`;
  const { model, note } = await chooseModel(what);
  if (o.onModel) o.onModel(modelLabel(model), note);
  const budget = budgetFor(model);
  const none = { text: '', model: modelLabel(model), note, files: 0, cut: 0, secrets: 0, withheld: 0 };
  let fitted;
  try {
    fitted = await source.patch(budget, signalOf(o.token));
  } catch (e) {
    if (stopped(e, o.token)) {
      log().info(`AI ${what}: stopped while reading the changes`);
      return none;
    }
    log().error(`AI ${what}: reading the changes failed: ${errorDetail(e)}`);
    throw logged(e);
  }
  log().info(`AI ${what}: ${fitted.files} file${fitted.files === 1 ? '' : 's'}${fitted.cut ? `, ${fitted.cut} shortened or left out` : ''}${fitted.withheld ? `, ${fitted.withheld} by name only` : ''}${fitted.secrets ? `, ${fitted.secrets} secret-looking values removed` : ''} (budget ${budget} characters)`);
  if (!fitted.files) throw unavailable(what, 'Nothing to summarize: no changes.');
  const text = await ask(model, P.summaryPrompt({ what: source.what, patch: fitted.text }), o.token, o.onText, what);
  // The model and who provides it (the fallback may be another vendor's than Copilot).
  return { text, model: modelLabel(model), note, files: fitted.files, cut: fitted.cut, secrets: fitted.secrets || 0, withheld: fitted.withheld || 0 };
}

module.exports = { AiUnavailable, enabled, commitMessage, summarize, worktreeSource, pullRequestSource, commitsSource, chooseModel, pickModel, warn };
