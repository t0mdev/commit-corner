// @ts-check
/* Commit Corner — worktrees overview webview. DOM APIs only (no HTML parsing of repository data). */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  // @ts-ignore shared helpers from icons.js
  const ui = window.gaUi;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  };

  function button(label, title, onClick, iconName, cls) {
    const b = el('button', `btn${cls ? ` ${cls}` : ''}`);
    if (iconName) b.appendChild(ui.icon(iconName));
    if (label) b.appendChild(el('span', '', label));
    b.title = title;
    if (!label) b.setAttribute('aria-label', title);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  const app = el('div', 'app');
  const header = el('div', 'header');
  const title = el('h1');
  title.append(ui.icon('worktree', { size: 18 }), el('span', '', 'Worktrees'));
  const repoName = el('span', 'repo');
  const summary = el('span', 'summary');
  const spacer = el('span', 'spacer');
  header.append(
    title, repoName, summary, spacer,
    button('Add Worktree…', 'Create a worktree for a new or existing branch', () => vscode.postMessage({ type: 'add' }), 'plus', 'primary'),
    button('Prune', 'Forget worktrees whose folders were deleted', () => vscode.postMessage({ type: 'prune' }), 'trash'),
    button('', 'Refresh', () => vscode.postMessage({ type: 'refresh' }), 'refresh'),
  );
  const help = el('div', 'help', 'Arrow keys move between worktrees · Enter opens one in a new window · Delete removes it · Tab reaches its buttons');
  const grid = el('div', 'grid');
  grid.setAttribute('role', 'list');
  grid.setAttribute('aria-label', 'Worktrees');
  const announcer = el('div', 'sr-only');
  announcer.setAttribute('aria-live', 'polite');
  app.append(header, help, grid, announcer);
  document.body.appendChild(app);

  let me = '';
  let focusedPath = '';

  function chips(c) {
    const wrap = el('span', 'chips');
    if (!c) return wrap;
    const chip = (cls, iconName, n, label) => {
      if (!n) return;
      const x = el('span', `chip ${cls}`);
      x.append(ui.icon(iconName, { size: 12 }), el('span', '', `${n} ${label}`));
      wrap.appendChild(x);
    };
    chip('chip-conflict', 'warning', c.conflicts, 'conflicted');
    chip('chip-staged', 'check', c.staged, 'staged');
    chip('chip-unstaged', 'edit', c.unstaged, 'changed');
    chip('chip-untracked', 'plus', c.untracked, 'untracked');
    if (!wrap.childNodes.length) {
      const clean = el('span', 'chip chip-staged');
      clean.append(ui.icon('check', { size: 12 }), el('span', '', 'clean'));
      wrap.appendChild(clean);
    }
    return wrap;
  }

  function describe(w) {
    const c = w.changes;
    const dirty = c ? c.staged + c.unstaged + c.untracked + c.conflicts : 0;
    return `${w.branch || 'detached HEAD'}${w.isCurrent ? ', this window' : ''}, ${w.path}, ${c ? (dirty ? `${dirty} uncommitted changes` : 'clean') : 'state unknown'}${w.ahead || w.behind ? `, ${w.ahead || 0} ahead, ${w.behind || 0} behind` : ''}${w.commit ? `, last commit ${w.commit.subject} by ${w.commit.authorName}, ${ui.longAge(w.commit.authorDate)}` : ''}`;
  }

  function card(w) {
    const c = w.changes;
    const dirty = c ? c.staged + c.unstaged + c.untracked + c.conflicts : 0;
    const state = c && c.conflicts ? 'conflict' : dirty ? 'dirty' : c ? 'clean' : 'unknown';
    const k = el('div', `card state-${state}${w.isCurrent ? ' current' : ''}`);
    k.tabIndex = 0;
    k.setAttribute('role', 'listitem');
    k.setAttribute('aria-label', describe(w));
    k.dataset.path = w.path;

    const head = el('div', 'card-head');
    head.append(ui.icon(w.isCurrent ? 'check' : w.locked ? 'lock' : w.branch ? 'branch' : 'commit', { size: 16 }), el('span', 'name', w.branch || (w.bare ? '(bare)' : `detached at ${(w.head || '').slice(0, 7)}`)));
    const flag = (text, cls) => head.appendChild(el('span', `flag ${cls || ''}`, text));
    if (w.isCurrent) flag('this window', 'flag-current');
    if (w.isMain) flag('main worktree');
    if (w.locked) flag(w.lockReason ? `locked: ${w.lockReason}` : 'locked', 'flag-warn');
    if (w.prunable) flag('folder missing', 'flag-warn');
    k.appendChild(head);

    const pathLine = el('div', 'line path');
    pathLine.append(ui.icon('folder'), el('span', 'mono', w.path));
    pathLine.title = w.path;
    k.appendChild(pathLine);

    const stateLine = el('div', 'line');
    stateLine.append(ui.icon('edit'), chips(c));
    if (!c) stateLine.appendChild(el('span', 'dim', w.error ? `unavailable: ${w.error}` : 'unavailable'));
    k.appendChild(stateLine);

    const sync = el('div', 'line');
    sync.appendChild(ui.icon('cloud'));
    if (w.upstream) {
      sync.appendChild(el('span', '', w.upstream));
      if (w.ahead) sync.appendChild(el('span', 'ahead', `↑${w.ahead}`));
      if (w.behind) sync.appendChild(el('span', 'behind', `↓${w.behind}`));
      if (!w.ahead && !w.behind) sync.appendChild(el('span', 'dim', 'up to date'));
    } else if (w.branch && w.base) {
      sync.appendChild(el('span', 'dim', `no upstream · vs ${w.base}`));
      if (w.baseAhead) sync.appendChild(el('span', 'ahead', `↑${w.baseAhead}`));
      if (w.baseBehind) sync.appendChild(el('span', 'behind', `↓${w.baseBehind}`));
    } else sync.appendChild(el('span', 'dim', w.branch ? 'no upstream branch' : 'detached HEAD'));
    k.appendChild(sync);

    if (w.commit) {
      const commit = el('div', 'commit');
      const you = me && w.commit.authorEmail && me.toLowerCase() === w.commit.authorEmail.toLowerCase();
      const text = el('div', 'commit-text');
      text.append(el('div', 'subject', w.commit.subject));
      const meta = el('div', 'dim');
      meta.append(el('code', 'sha-chip', w.commit.sha.slice(0, 7)), ` ${w.commit.authorName}${you ? ' (you)' : ''} · ${ui.longAge(w.commit.authorDate)}`);
      meta.title = ui.fullDate(w.commit.authorDate);
      text.appendChild(meta);
      commit.append(ui.avatar(w.commit.authorName, w.commit.authorEmail, 26), text);
      k.appendChild(commit);
    }

    const act = el('div', 'actions');
    const send = (action) => vscode.postMessage({ type: 'action', action, path: w.path });
    if (!w.isCurrent && !w.prunable) {
      act.append(
        button('Open', 'Open in a new window (Enter)', () => send('open'), 'window', 'primary'),
        button('Open Here', 'Open in this window', () => send('openHere'), 'open'),
      );
    }
    if (!w.prunable) act.appendChild(button('Add to Workspace', 'Add the folder to this workspace', () => send('addToWorkspace'), 'plus'));
    if (!w.isMain && w.head && !w.prunable) act.appendChild(button('Changes vs Base', 'Everything it changed since it left the default branch: its commits and uncommitted work together', () => send('changesVsBase'), 'diff'));
    if (w.head) act.appendChild(button('Graph', 'Show its commit in the graph', () => vscode.postMessage({ type: 'graph', sha: w.head }), 'graph'));
    if (!w.isMain) act.appendChild(w.locked ? button('Unlock', 'Allow pruning and removing again', () => send('unlock'), 'lock') : button('Lock', 'Protect from pruning (e.g. on a removable drive)', () => send('lock'), 'lock'));
    if (!w.isMain && !w.isCurrent && !w.locked) act.appendChild(button('Remove…', 'Delete the worktree folder (Delete); the branch is kept', () => send('remove'), 'trash', 'danger'));
    k.appendChild(act);

    k.addEventListener('focus', () => {
      focusedPath = w.path;
    });
    k.addEventListener('keydown', (e) => {
      if (e.target !== k) return;
      if (e.key === 'Enter' && !w.isCurrent && !w.prunable) {
        e.preventDefault();
        send('open');
      } else if (e.key === 'Delete' && !w.isMain && !w.isCurrent && !w.locked) {
        e.preventDefault();
        send('remove');
      }
    });
    return k;
  }

  /** Arrow keys / Home / End move between cards, in reading order. */
  grid.addEventListener('keydown', (e) => {
    const cards = [...grid.querySelectorAll('.card')];
    const i = cards.indexOf(/** @type {Element} */ (document.activeElement));
    if (i < 0 || e.target !== cards[i]) return;
    const perRow = Math.max(1, Math.round(grid.clientWidth / cards[0].getBoundingClientRect().width));
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + perRow, ArrowUp: i - perRow, Home: 0, End: cards.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    /** @type {HTMLElement} */ (cards[Math.max(0, Math.min(cards.length - 1, to))]).focus();
  });

  // Esc from a card's button goes back to its card.
  grid.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const k = /** @type {HTMLElement} */ (e.target).closest('.card');
    if (k && k !== e.target) {
      e.preventDefault();
      /** @type {HTMLElement} */ (k).focus();
    }
  });

  window.addEventListener('message', (event) => {
    const m = event.data;
    if (m.type === 'error') {
      grid.replaceChildren(el('div', 'error', m.message));
      return;
    }
    if (m.type !== 'data') return;
    me = m.me || '';
    vscode.setState({ repoRoot: m.repoRoot });
    repoName.textContent = m.repoName;
    const dirty = m.worktrees.filter((w) => w.changes && w.changes.staged + w.changes.unstaged + w.changes.untracked + w.changes.conflicts).length;
    summary.textContent = `${m.worktrees.length} worktree${m.worktrees.length === 1 ? '' : 's'}${dirty ? ` · ${dirty} with uncommitted changes` : ''}`;
    const hadFocus = grid.contains(document.activeElement);
    const keep = focusedPath;
    grid.replaceChildren(...m.worktrees.map(card));
    const target = /** @type {HTMLElement|null} */ ([...grid.querySelectorAll('.card')].find((k) => /** @type {HTMLElement} */ (k).dataset.path === keep) || grid.querySelector('.card'));
    // Only when this page has the keyboard (or just opened with it): a refresh in the background
    // must never pull the keyboard away from where you are typing.
    if (target && (hadFocus || (document.hasFocus() && (!document.activeElement || document.activeElement === document.body)))) target.focus();
    announcer.textContent = summary.textContent;
  });

  vscode.postMessage({ type: 'ready' });
})();
