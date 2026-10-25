// @ts-check
/* Commit Corner — interactive rebase editor webview. DOM APIs only. */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  // @ts-ignore shared helpers from icons.js
  const ui = window.gaUi;
  const ACTIONS = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];
  const KEYS = { p: 'pick', r: 'reword', e: 'edit', s: 'squash', f: 'fixup', d: 'drop' };
  const DESCRIPTIONS = {
    pick: 'use the commit',
    reword: 'use the commit, change its message',
    edit: 'stop after this commit to amend it',
    squash: 'fold into the previous commit, combining messages',
    fixup: 'fold into the previous commit, discarding this message',
    drop: 'remove the commit',
  };

  /** @type {any[]} */
  let plan = [];
  let original = [];
  let allowMessages = false;
  let mode = 'command';
  let focused = 0;
  /** Plan snapshots for Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z). */
  let undoStack = [];
  let redoStack = [];
  /** A message box records one undo step when its typing starts, not per keystroke. */
  let typingRecorded = false;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  };

  const app = el('div', 'app');
  const title = el('h1', '', 'Interactive Rebase');
  const sub = el('div', 'sub');
  const help = el('div', 'help');
  help.append(
    'Commits are applied top to bottom. Drag rows or use ',
    el('kbd', '', 'Alt+↑/↓'), ' to reorder; ',
    el('kbd', '', 'P'), ' pick, ', el('kbd', '', 'R'), ' reword, ', el('kbd', '', 'E'), ' edit, ',
    el('kbd', '', 'S'), ' squash, ', el('kbd', '', 'F'), ' fixup, ', el('kbd', '', 'D'), ' drop; ',
    el('kbd', '', 'Enter'), ' shows a commit; ', el('kbd', '', 'Tab'), ' reaches a row\'s action and message; ',
    el('kbd', '', 'Ctrl+Z'), ' / ', el('kbd', '', 'Ctrl+Y'), ' undo / redo; ', el('kbd', '', 'Ctrl+Enter'), ' starts; ', el('kbd', '', 'Esc'), ' cancels (asks first when the plan changed).',
  );
  const toolbar = el('div', 'toolbar');
  const summary = el('span', 'summary');
  const startBtn = el('button', 'btn primary', 'Start Rebase');
  const resetBtn = el('button', 'btn', 'Reset');
  const cancelBtn = el('button', 'btn', 'Cancel');
  toolbar.append(summary, el('span', 'spacer'), resetBtn, cancelBtn, startBtn);
  const status = el('div', 'sr-only');
  status.setAttribute('aria-live', 'polite');
  const warning = el('div', 'warning');
  warning.setAttribute('role', 'alert'); // announced when the plan becomes invalid
  const list = el('div', 'list');
  list.setAttribute('role', 'list');
  list.setAttribute('aria-label', 'Rebase plan, applied top to bottom');
  app.append(title, sub, help, toolbar, warning, list, status);
  document.body.appendChild(app);

  startBtn.addEventListener('click', () => vscode.postMessage({ type: 'start', plan: plan.map(stripUi) }));
  cancelBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  resetBtn.addEventListener('click', () => {
    record();
    plan = clone(original);
    render();
  });

  const clone = (v) => JSON.parse(JSON.stringify(v));

  /** Remember the plan before a change, so it can be undone. */
  function record() {
    undoStack.push(clone(plan));
    if (undoStack.length > 200) undoStack.shift();
    redoStack = [];
  }

  function undoRedo(redo) {
    const from = redo ? redoStack : undoStack;
    const to = redo ? undoStack : redoStack;
    if (!from.length) {
      status.textContent = redo ? 'Nothing to redo' : 'Nothing to undo';
      return;
    }
    to.push(clone(plan));
    plan = from.pop();
    typingRecorded = false;
    render();
    focusRow(Math.min(focused, plan.length - 1) >= 0 ? nearestCommit(Math.min(focused, plan.length - 1)) : 0);
    status.textContent = redo ? 'Redone' : 'Undone';
  }

  /** The commit row at or nearest after/before index i. */
  function nearestCommit(i) {
    for (let d = 0; d < plan.length; d++) {
      if (plan[i + d] && plan[i + d].type === 'commit') return i + d;
      if (plan[i - d] && plan[i - d].type === 'commit') return i - d;
    }
    return 0;
  }
  const stripUi = (e) => {
    const { autoMessage, ...rest } = e;
    void autoMessage;
    return rest;
  };
  /** What the user decided: order, actions and typed messages (not generated ones). */
  const planKey = (p) => JSON.stringify(p.map((e) => (e.type === 'commit' ? [e.sha, e.action, e.autoMessage ? null : e.newMessage] : e.text)));
  const isDirty = () => planKey(plan) !== planKey(original);

  /** Index of the commit an entry folds into (for squash/fixup), or -1. */
  function foldTarget(i) {
    for (let k = i - 1; k >= 0; k--) {
      const e = plan[k];
      if (e.type !== 'commit' || e.action === 'drop') continue;
      if (e.action === 'squash' || e.action === 'fixup') continue;
      return k;
    }
    return -1;
  }

  /** Group heads that have squash members (they get a combined message editor). */
  function squashGroups() {
    const groups = new Map();
    plan.forEach((e, i) => {
      if (e.type !== 'commit' || e.action !== 'squash') return;
      const head = foldTarget(i);
      if (head < 0) return;
      if (!groups.has(head)) groups.set(head, []);
      groups.get(head).push(i);
    });
    return groups;
  }

  function validate() {
    const firstLive = plan.find((e) => e.type === 'commit' && e.action !== 'drop');
    if (firstLive && (firstLive.action === 'squash' || firstLive.action === 'fixup')) return `The first commit cannot be "${firstLive.action}".`;
    return '';
  }

  function updateSummary() {
    const commits = plan.filter((e) => e.type === 'commit');
    // Every surviving commit that does not fold into a previous one becomes a commit.
    const result = plan.filter((e, i) => e.type === 'commit' && e.action !== 'drop' && !((e.action === 'squash' || e.action === 'fixup') && foldTarget(i) >= 0)).length;
    const dropped = commits.filter((e) => e.action === 'drop').length;
    summary.textContent = `${commits.length} commit${commits.length === 1 ? '' : 's'} → ${result} commit${result === 1 ? '' : 's'}${dropped ? ` (${dropped} dropped)` : ''}`;
    const problem = validate();
    warning.textContent = problem;
    /** @type {HTMLButtonElement} */ (startBtn).disabled = !!problem;
  }

  function messageEditor(label, value, onInput) {
    const wrap = el('div', 'message-editor');
    const l = el('label', '', label);
    const ta = /** @type {HTMLTextAreaElement} */ (el('textarea'));
    ta.value = value;
    ta.addEventListener('focus', () => {
      typingRecorded = false;
    });
    ta.addEventListener('input', () => {
      if (!typingRecorded) {
        // Snapshot before the first change: the plan still holds the previous text.
        undoStack.push(clone(plan));
        redoStack = [];
        typingRecorded = true;
      }
      onInput(ta.value);
    });
    ta.setAttribute('aria-label', label);
    // Escape leaves the text box (back to its commit row); everything else bubbles normally so
    // VS Code's own shortcuts and Ctrl+Enter keep working here.
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        const row = ta.closest('.entry');
        if (row) row.focus();
      }
    });
    wrap.append(l, ta);
    return wrap;
  }

  function render() {
    const groups = squashGroups();
    list.replaceChildren();
    plan.forEach((e, i) => {
      if (e.type !== 'commit') {
        const row = el('div', 'entry other');
        row.append(el('span', 'handle', ''), el('span', '', e.text));
        list.appendChild(row);
        return;
      }
      const folded = (e.action === 'squash' || e.action === 'fixup') && foldTarget(i) >= 0;
      const row = el('div', `entry a-${e.action}${folded ? ' folded' : ''}${i === focused ? ' focused' : ''}`);
      row.tabIndex = 0;
      row.draggable = true;
      row.dataset.index = String(i);
      row.setAttribute('role', 'listitem');
      row.setAttribute('aria-label', `${e.action} ${e.sha.slice(0, 7)} ${e.subject}${e.author ? ` by ${e.author}` : ''}${e.pushed ? ', already pushed' : ''}`);
      const handle = el('span', 'handle', '⋮⋮');
      handle.title = 'Drag to reorder';
      const select = /** @type {HTMLSelectElement} */ (el('select', `action a-${e.action}`));
      for (const a of ACTIONS) {
        const o = el('option', '', a);
        o.setAttribute('value', a);
        o.title = DESCRIPTIONS[a];
        select.appendChild(o);
      }
      select.value = e.action;
      select.title = DESCRIPTIONS[e.action];
      select.addEventListener('change', () => setAction(i, select.value, 'select'));
      // Esc in the action list goes back to its row, like in a message box.
      select.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          row.focus();
        }
      });
      select.setAttribute('aria-label', `Action for ${e.subject}`);
      const sha = el('span', 'sha', e.sha.slice(0, 7));
      sha.title = 'Show this commit\'s changes';
      sha.addEventListener('click', () => vscode.postMessage({ type: 'openCommit', sha: e.sha }));
      const subject = el('span', 'subject', e.subject);
      subject.title = e.message || e.subject;
      // When and who, as in the graph: short age, avatar and name.
      const author = el('span', 'author');
      if (e.author) author.append(ui.avatar(e.author, e.email, 16), document.createTextNode(` ${e.author}`));
      const date = el('span', 'date', e.date ? ui.shortAge(e.date) : '');
      if (e.date) date.title = `${ui.longAge(e.date)} — ${ui.fullDate(e.date)}`;
      if (e.pushed) {
        // Already on the upstream: rewriting it needs a force push.
        const chip = el('span', 'pushed', 'pushed');
        chip.title = 'Already on the upstream branch: changing it needs a force push';
        subject.prepend(chip);
      }
      row.append(handle, select, sha, subject, author, date);

      if (allowMessages && e.action === 'reword' && !groups.has(i)) {
        row.appendChild(messageEditor('New message', e.newMessage !== undefined ? e.newMessage : e.message || e.subject, (v) => {
          e.newMessage = v;
        }));
      }
      if (allowMessages && groups.has(i) && e.action !== 'drop') {
        const members = [i, ...groups.get(i)];
        const combined = members.map((k) => (plan[k].message || plan[k].subject).trim()).join('\n\n');
        if (e.newMessage === undefined || e.autoMessage) {
          e.newMessage = combined;
          e.autoMessage = true;
        }
        row.appendChild(messageEditor(`Message of the combined commit (${members.length} commits)`, e.newMessage, (v) => {
          e.newMessage = v;
          e.autoMessage = false;
        }));
      }

      row.addEventListener('focus', () => {
        focused = i;
      });
      row.addEventListener('keydown', (ev) => onKey(ev, i));
      row.addEventListener('dragstart', (ev) => {
        dragFrom = i;
        row.classList.add('dragging');
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        clearDropMarks();
      });
      row.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        clearDropMarks();
        const rect = row.getBoundingClientRect();
        row.classList.add(ev.clientY < rect.top + rect.height / 2 ? 'drop-before' : 'drop-after');
      });
      row.addEventListener('drop', (ev) => {
        ev.preventDefault();
        const rect = row.getBoundingClientRect();
        const after = ev.clientY >= rect.top + rect.height / 2;
        clearDropMarks();
        if (dragFrom < 0) return;
        record();
        let to = i + (after ? 1 : 0);
        const [moved] = plan.splice(dragFrom, 1);
        if (dragFrom < to) to--;
        plan.splice(to, 0, moved);
        focused = to;
        dragFrom = -1;
        render();
        focusRow(focused);
      });
      list.appendChild(row);
    });
    updateSummary();
  }

  let dragFrom = -1;
  function clearDropMarks() {
    list.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
  }

  function focusRow(i) {
    const row = /** @type {HTMLElement|null} */ (list.querySelector(`.entry[data-index="${i}"]`));
    if (row) row.focus();
  }

  /**
   * @param {'row'|'select'} [keep] what gets focus back after re-rendering: the row (letter keys),
   *        or the row's action dropdown (so arrowing through it keeps working)
   */
  function setAction(i, action, keep = 'row') {
    const e = plan[i];
    if (e.type !== 'commit' || e.action === action) return;
    record();
    plan[i].action = action;
    render();
    const row = /** @type {HTMLElement|null} */ (list.querySelector(`.entry[data-index="${i}"]`));
    if (!row) return;
    const box = /** @type {HTMLElement|null} */ (row.querySelector('textarea'));
    if (keep === 'select') /** @type {HTMLElement} */ (row.querySelector('select')).focus();
    else if (action === 'reword' && box) box.focus(); // R: type the new message right away
    else row.focus();
  }

  function move(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= plan.length) return;
    record();
    [plan[i], plan[j]] = [plan[j], plan[i]];
    focused = j;
    render();
    focusRow(j);
    const commits = plan.filter((e) => e.type === 'commit');
    status.textContent = `Moved to position ${commits.indexOf(plan[j]) + 1} of ${commits.length}`;
  }

  // Ctrl/Cmd+Enter starts the rebase from anywhere in the editor.
  document.addEventListener('keydown', (ev) => {
    // Undo / redo of the plan. In a message box the box's own text undo applies instead.
    const mod = ev.ctrlKey || ev.metaKey;
    const inText = /** @type {HTMLElement} */ (ev.target).tagName === 'TEXTAREA';
    if (mod && !ev.altKey && !inText && (ev.key === 'z' || ev.key === 'Z' || ev.key === 'y' || ev.key === 'Y')) {
      ev.preventDefault();
      undoRedo(ev.key.toLowerCase() === 'y' || ev.shiftKey);
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter' && !startBtn.disabled) {
      ev.preventDefault();
      vscode.postMessage({ type: 'start', plan: plan.map(stripUi) });
    }
  });

  /** Next commit row in a direction, skipping exec/break/label lines (not focusable). */
  function nextCommitIndex(i, dir) {
    for (let j = i + dir; j >= 0 && j < plan.length; j += dir) if (plan[j].type === 'commit') return j;
    return i;
  }

  function onKey(ev, i) {
    // Keys typed into the row's action dropdown or message box belong to them.
    if (ev.target !== ev.currentTarget) return;
    if ((ev.key === 'Enter' || ev.key === ' ') && !ev.ctrlKey && !ev.metaKey) {
      ev.preventDefault();
      vscode.postMessage({ type: 'openCommit', sha: plan[i].sha });
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      // The host asks before discarding an edited plan (or aborting a running rebase).
      vscode.postMessage({ type: 'cancel', viaKey: true, dirty: isDirty() });
      return;
    }
    if (ev.key === 'Home' || ev.key === 'End' || ev.key === 'PageUp' || ev.key === 'PageDown') {
      ev.preventDefault();
      const commits = plan.map((e, k) => (e.type === 'commit' ? k : -1)).filter((k) => k >= 0);
      if (!commits.length) return;
      const pos = Math.max(0, commits.indexOf(i));
      const step = 10;
      let to;
      if (ev.key === 'Home') to = 0;
      else if (ev.key === 'End') to = commits.length - 1;
      else to = Math.max(0, Math.min(commits.length - 1, pos + (ev.key === 'PageUp' ? -step : step)));
      focused = commits[to];
      focusRow(focused);
      return;
    }
    if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
      ev.preventDefault();
      move(i, ev.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      const j = nextCommitIndex(i, ev.key === 'ArrowUp' ? -1 : 1);
      focused = j;
      focusRow(j);
      return;
    }
    const a = KEYS[ev.key.toLowerCase()];
    if (a && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      ev.preventDefault();
      setAction(i, a);
    }
  }

  window.addEventListener('message', (event) => {
    const m = event.data;
    if (m.type !== 'init') return;
    plan = m.entries.map((e) => ({ ...e }));
    original = clone(plan);
    undoStack = [];
    redoStack = [];
    allowMessages = m.allowMessages;
    mode = m.mode;
    title.textContent = mode === 'todo' ? 'Interactive Rebase (git-rebase-todo)' : `Interactive Rebase${m.branch ? ` of ${m.branch}` : ''}`;
    sub.textContent = m.onto ? (mode === 'todo' ? m.onto : `Onto ${m.onto}`) : '';
    cancelBtn.textContent = mode === 'todo' ? 'Abort Rebase' : 'Cancel';
    if (mode === 'todo') help.append(' Reword messages are asked for by git while the rebase runs.');
    render();
    focusRow(nextCommitIndex(-1, 1));
  });

  vscode.postMessage({ type: 'ready' });
})();
