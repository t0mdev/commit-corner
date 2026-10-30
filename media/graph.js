// @ts-check
/* Commit Corner — commit graph webview.
 * Everything is built with DOM APIs (textContent, createElement): repository
 * data is never parsed as HTML. */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  // @ts-ignore shared helpers from icons.js
  const ui = window.gaUi;
  const ROW_H = 24;
  /** Height of a time-range separator (sidebar). */
  const SEP_H = 16;
  const LANE_W = 14;
  const MAX_LANES_SHOWN = 24;
  /** In the narrow sidebar, wider histories are clipped to this many lanes. */
  const MAX_LANES_COMPACT = 8;
  const lanesShown = () => Math.min(maxWidth, settings.compact ? (window.innerWidth < 360 ? 4 : MAX_LANES_COMPACT) : MAX_LANES_SHOWN);
  const OVERSCAN = 12;
  const WORKTREE_SHA = '*';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** @type {any[]} */
  let rows = [];
  let maxWidth = 1;
  let hasMore = false;
  let head = null;
  let settings = { showAuthor: true, showDate: true, showSha: true, showChanges: true, dateFormat: 'relative' };
  /** The user's e-mail, to mark their own commits. */
  let me = '';
  /** sha -> uncommitted work of another worktree checked out there ({name, staged, …}). */
  let wipBySha = {};
  /** "✎ 3": another worktree (an agent's) has uncommitted work on this commit. */
  function wipChip(r) {
    const w = wipBySha[r.sha];
    if (!w) return undefined;
    const n = (w.staged || 0) + (w.unstaged || 0) + (w.untracked || 0) + (w.conflicts || 0);
    const c = el('span', 'chip chip-wip');
    c.append(ui.icon('edit', { size: 12 }), el('span', '', String(n)));
    c.title = `Worktree ${w.name}: ${[w.conflicts && `${w.conflicts} conflicted`, w.staged && `${w.staged} staged`, w.unstaged && `${w.unstaged} changed`, w.untracked && `${w.untracked} untracked`].filter(Boolean).join(', ')} — not committed yet. Click to see them.`;
    c.addEventListener('mousedown', (ev) => ev.stopPropagation());
    c.addEventListener('click', (ev) => {
      ev.stopPropagation();
      vscode.postMessage({ type: 'worktreeChanges', sha: r.sha });
    });
    return c;
  }
  /** Whether the repository has a github.com remote (GitHub buttons). */
  let onGitHub = false;
  /** sha -> [files, added, deleted], filled lazily for the rows on screen. */
  const stats = new Map();
  /** What B compares a file with (the host says, after each load). */
  let compareBaseName = '';
  /** sha -> [viewed, total]: commits you started on (some file opened). */
  const viewedCounts = new Map();
  /** Viewed mark key -> viewed, as the host last said (newer than the file lists drawn before). */
  const vkState = new Map();
  const statsRequested = new Set();
  /** @type {Set<string>} */
  let selected = new Set();
  let anchor = -1;
  let cursor = -1;
  let highlight = '';
  /** @type {number[]} */
  let matches = [];
  let matchSet = new Set();
  let matchPos = -1;
  /** @type {Map<string, number>} */
  let indexBySha = new Map();
  let firstLoad = true;
  const saved = vscode.getState() || {};

  // ---------------------------------------------------------------- DOM setup

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  };

  const root = el('div', 'app');
  const toolbar = el('div', 'toolbar');
  const repoLabel = el('span', 'repo');
  const repoName = el('span', 'repo-name');
  repoLabel.append(ui.icon('folder'), repoName);
  // Several repositories open: the name is a switch (the sidebar has it in the view's title bar).
  const repoChevron = ui.icon('chevron', { size: 11 });
  repoChevron.classList.add('repo-chevron');
  repoLabel.appendChild(repoChevron);
  const switchRepo = () => {
    if (repoLabel.classList.contains('switchable')) vscode.postMessage({ type: 'switchRepo' });
  };
  repoLabel.addEventListener('click', switchRepo);
  repoLabel.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      switchRepo();
    }
  });
  function setMultiRepo(multi) {
    repoLabel.classList.toggle('switchable', !!multi);
    repoLabel.tabIndex = multi ? 0 : -1;
    if (multi) {
      repoLabel.setAttribute('role', 'button');
      repoLabel.title = 'Switch repository (Ctrl+Alt+G Shift+O)';
    } else {
      repoLabel.removeAttribute('role');
      repoLabel.removeAttribute('title');
    }
  }
  const branchBtn = button('', 'Current branch: check out another one (Ctrl+Alt+G O)', () => vscode.postMessage({ type: 'command', command: 'commitCorner.checkout', args: {} }), 'branch');
  branchBtn.classList.add('branch-btn');
  const filterSelect = /** @type {HTMLSelectElement} */ (el('select', 'filter'));
  filterSelect.title = 'Which history to show';
  filterSelect.setAttribute('aria-label', 'Which history to show');
  const filterWrap = el('span', 'field');
  filterWrap.append(ui.icon('filter'), filterSelect);
  const searchBox = /** @type {HTMLInputElement} */ (el('input', 'search'));
  searchBox.type = 'search';
  searchBox.placeholder = 'Search (Ctrl+F)…';
  searchBox.setAttribute('aria-label', 'Search commits');
  const searchWrap = el('span', 'field');
  const modeSelect = /** @type {HTMLSelectElement} */ (el('select', 'mode'));
  [['highlight', 'Highlight loaded'], ['message', 'Message (all history)'], ['author', 'Author'], ['file', 'File path'], ['content', 'Code change (-S)'], ['sha', 'Go to SHA / ref']].forEach(([v, l]) => {
    const o = el('option', '', l);
    o.setAttribute('value', v);
    modeSelect.appendChild(o);
  });
  modeSelect.title = 'Search mode. "Highlight" searches loaded commits instantly; the others ask git and filter the graph.';
  modeSelect.setAttribute('aria-label', 'Search mode');
  searchWrap.append(ui.icon('search'), searchBox, modeSelect);
  const matchInfo = el('span', 'match-info');
  const prevBtn = button('', 'Previous match (Shift+Enter)', () => jumpMatch(-1), 'up');
  const nextBtn = button('', 'Next match (Enter)', () => jumpMatch(1), 'down');
  const clearBtn = button('', 'Clear search (Escape)', () => clearSearch(), 'close');
  const spacer = el('span', 'spacer');
  const refreshBtn = button('', 'Refresh', () => vscode.postMessage({ type: 'refresh' }), 'refresh');
  const pullBtn = button('Pull', 'Pull from the upstream branch (Ctrl+Alt+G Shift+F)', () => vscode.postMessage({ type: 'command', command: 'commitCorner.pull', args: {} }), 'down');
  const pushBtn = button('Push', 'Push to the upstream branch (Ctrl+Alt+G Shift+P)', () => vscode.postMessage({ type: 'command', command: 'commitCorner.push', args: {} }), 'up');
  pushBtn.classList.add('primary');
  const fetchBtn = button('Fetch', 'Fetch from remotes (Ctrl+Alt+G F)', () => vscode.postMessage({ type: 'command', command: 'commitCorner.fetch', args: {} }), 'cloudDown');
  const headBtn = button('HEAD', 'Jump to the checked-out commit', () => revealSha(head && head.sha, true), 'target');
  const collapseBtn = button('', 'Collapse all commits', () => collapseAll(), 'collapse');
  toolbar.append(repoLabel, branchBtn, filterWrap, searchWrap, prevBtn, nextBtn, clearBtn, matchInfo, spacer, headBtn, pullBtn, pushBtn, fetchBtn, collapseBtn, refreshBtn);
  for (const part of [searchWrap, prevBtn, nextBtn, clearBtn, matchInfo]) part.classList.add('search-part');
  searchBox.addEventListener('input', () => updateSearchParts());

  const listWrap = el('div', 'list-wrap');
  const header = el('div', 'row header');
  const scroller = el('div', 'scroller');
  scroller.tabIndex = 0;
  scroller.setAttribute('role', 'listbox');
  scroller.setAttribute('aria-multiselectable', 'true');
  scroller.setAttribute('aria-label', 'Commits');
  // The key help is a description (read on request), not part of the name read on every visit.
  const listHelp = el('div', 'sr-only', 'Arrows move, Shift+arrows extend, Ctrl+arrows move without selecting, Ctrl+Space toggles, Enter opens, Shift+F10 or . for actions, ? for help.');
  listHelp.id = 'list-help';
  scroller.setAttribute('aria-describedby', 'list-help');
  const announcer = el('div', 'sr-only');
  announcer.setAttribute('aria-live', 'polite');
  const sizer = el('div', 'sizer');
  const layer = el('div', 'layer');
  sizer.appendChild(layer);
  scroller.appendChild(sizer);
  const overlay = el('div', 'overlay', 'Loading…');
  listWrap.append(header, scroller, overlay, announcer, listHelp);

  const splitter = el('div', 'splitter');
  splitter.title = 'Drag to resize';
  const detailsPane = el('div', 'details');
  detailsPane.appendChild(el('div', 'placeholder', 'Select a commit to see its details. Ctrl/Cmd+click or Shift+click to select several.'));

  // Sidebar (compact) only: what happened lately, linking to the Activity tab.
  const summaryBar = el('button', 'summary-bar');
  summaryBar.hidden = true;
  summaryBar.type = 'button';
  summaryBar.addEventListener('click', () => vscode.postMessage({ type: 'activity' }));
  // The sidebar's view switcher, always in sight (the title bar's dropdown shows only on hover).
  const topBar = el('div', 'top-bar');
  const viewBtn = button('Graph', 'Switch view: Repository, Pull Requests, Compare, File History, Worktrees', () => vscode.postMessage({ type: 'switchView' }), 'menu');
  viewBtn.classList.add('view-switch');
  viewBtn.appendChild(ui.icon('chevron', { size: 10 }));
  topBar.append(viewBtn, summaryBar);
  root.append(topBar, toolbar, listWrap, splitter, detailsPane);
  document.body.appendChild(root);
  if (saved.detailsHeight) detailsPane.style.height = saved.detailsHeight + 'px';
  if (saved.mode) modeSelect.value = saved.mode;

  /** A button, optionally with an icon; icon-only buttons get their title as accessible name. */
  function button(label, title, onClick, iconName) {
    const b = el('button', 'btn');
    if (iconName) b.appendChild(ui.icon(iconName));
    if (label) b.appendChild(el('span', 'label', label));
    else b.classList.add('icon-only');
    b.title = title;
    // The label may be hidden in a narrow toolbar; the accessible name stays.
    b.setAttribute('aria-label', label || title);
    b.addEventListener('click', onClick);
    return b;
  }

  /** Toolbar state from the current branch: name, ahead/behind on Push / Pull. */
  function updateToolbar() {
    const label = branchBtn.querySelector('.label') || branchBtn.appendChild(el('span', 'label'));
    label.textContent = head && head.branch ? head.branch : head && head.sha ? `detached at ${short(head.sha)}` : 'no commits';
    branchBtn.classList.remove('icon-only');
    branchBtn.setAttribute('aria-label', `Current branch ${label.textContent}: check out another one`);
    const ahead = (head && head.ahead) || 0;
    const behind = (head && head.behind) || 0;
    const counted = (b, n, word) => {
      const old = b.querySelector('.count');
      if (old) old.remove();
      if (n) b.appendChild(el('span', 'count', String(n)));
      b.setAttribute('aria-label', n ? `${word} (${n} commit${n === 1 ? '' : 's'})` : word);
    };
    counted(pushBtn, ahead, 'Push');
    counted(pullBtn, behind, 'Pull');
    pushBtn.classList.toggle('primary', ahead > 0);
    pullBtn.classList.toggle('primary', behind > 0 && !ahead);
    // Without an upstream there is nothing to pull; Push still offers to publish the branch.
    pullBtn.hidden = !(head && head.upstream);
  }

  function persist(extra) {
    Object.assign(saved, extra);
    vscode.setState(saved);
  }

  // ---------------------------------------------------------------- formatting

  function fmtDate(ms) {
    if (!ms) return '';
    if (settings.dateFormat === 'relative') return ui.shortAge(ms);
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    return settings.dateFormat === 'date' ? date : `${date} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  const short = (sha) => (sha ? sha.slice(0, 7) : '');

  // ---------------------------------------------------------------- graph drawing

  const x = (lane) => lane * LANE_W + LANE_W / 2 + 2;

  function drawGraph(r) {
    const width = lanesShown() * LANE_W + 6;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(ROW_H));
    svg.setAttribute('class', 'graph-svg');
    const g = r.g;
    const H = ROW_H;
    const M = H / 2;
    for (const l of g.lines) {
      const p = document.createElementNS(SVG_NS, 'path');
      let d;
      if (l.kind === 'pass') {
        const x1 = x(l.from);
        const x2 = x(l.to);
        d = x1 === x2 ? `M${x1} 0V${H}` : `M${x1} 0C${x1} ${M} ${x2} ${M} ${x2} ${H}`;
      } else if (l.kind === 'in') {
        const x1 = x(l.from);
        const x2 = x(l.to);
        d = x1 === x2 ? `M${x1} 0V${M}` : `M${x1} 0C${x1} ${M * 0.8} ${x2} ${M * 0.4} ${x2} ${M}`;
      } else {
        const x1 = x(l.from);
        const x2 = x(l.to);
        d = x1 === x2 ? `M${x1} ${M}V${H}` : `M${x1} ${M}C${x1} ${M + M * 0.6} ${x2} ${M + M * 0.2} ${x2} ${H}`;
      }
      p.setAttribute('d', d);
      p.setAttribute('class', `lane c${l.color}`);
      svg.appendChild(p);
    }
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', String(x(g.col)));
    c.setAttribute('cy', String(M));
    const isHead = head && head.sha === r.sha;
    const isWorktree = r.sha === WORKTREE_SHA;
    c.setAttribute('r', isHead ? '5' : '4');
    c.setAttribute('class', `node c${g.color}${isHead ? ' head' : ''}${g.isMerge ? ' merge' : ''}${isWorktree ? ' worktree' : ''}`);
    svg.appendChild(c);
    return svg;
  }

  // ---------------------------------------------------------------- rows

  /** The SHA column: off in a narrow editor graph (a diff open beside it). */
  const shaShown = () => !!settings.showSha && !root.classList.contains('tight');

  function graphWidth() {
    return Math.max(settings.compact ? 24 : 56, lanesShown() * LANE_W + 10);
  }

  /**
   * Where a file line's content starts (px from the end of the lanes): one step in from the
   * commit's ▸, and 12 px more per folder level — a tree under the commit.
   */
  const fileIndent = (depth) => (settings.compact ? 0 : 6) + 14 + depth * 12;

  function applyColumns() {
    root.classList.toggle('compact', !!settings.compact);
    // All views stacked: each has its own title, no switcher needed.
    viewBtn.hidden = settings.oneView === false;
    document.body.classList.toggle('in-sidebar', !!settings.compact);
    // A tree in both graphs: commits (and the uncommitted changes) expand to their files.
    scroller.setAttribute('role', 'tree');
    listHelp.textContent = 'Up and Down move through commits and the files of open commits, Right opens a commit\'s files, Left closes them, Shift+arrows extend, Ctrl+Space toggles, Space previews, Enter opens, Shift+F10 or . for actions, ? for help.';
    // A narrow sidebar (the default ~300 px): a slimmer change bar (it stays: how much changed
    // is part of every row), fewer lanes and shorter badges, so the message gets the room.
    const narrow = !!settings.compact && window.innerWidth < 360;
    root.classList.toggle('narrow', narrow);
    if (settings.compact) {
      // Sidebar: lanes │ ▸ │ when │ who │ how much │ what — the same columns on every row; the
      // expander first, so a commit's files are indented under it like a tree.
      root.style.setProperty('--cols', `${graphWidth()}px 16px 34px 22px ${narrow ? 20 : 30}px minmax(60px, 1fr)`);
      header.replaceChildren();
      return;
    }
    const relative = settings.dateFormat === 'relative';
    // Narrow (a diff open beside it): the message keeps its room; the author is its avatar.
    const tight = !settings.compact && window.innerWidth < 700;
    root.classList.toggle('tight', tight);
    const cols = [`${graphWidth()}px`, 'minmax(160px, 1fr)'];
    if (settings.showAuthor) cols.push(tight ? '30px' : '150px');
    // Very narrow (a side panel open too): the change bar alone, as in the sidebar.
    const xtight = tight && window.innerWidth < 520;
    root.classList.toggle('xtight', xtight);
    if (settings.showChanges) cols.push(xtight ? '34px' : '118px');
    if (settings.showDate) cols.push(relative ? '74px' : '130px');
    if (shaShown()) cols.push('70px');
    root.style.setProperty('--cols', cols.join(' '));
    const col = (iconName, text) => {
      const c = el('div', 'cell');
      if (iconName) c.appendChild(ui.icon(iconName));
      c.appendChild(el('span', '', text));
      return c;
    };
    header.replaceChildren(el('div', 'cell', ''), col('commit', 'Message'));
    if (settings.showAuthor) header.appendChild(col('person', 'Author'));
    if (settings.showChanges) header.appendChild(col('diff', 'Changes'));
    if (settings.showDate) header.appendChild(col('clock', relative ? 'When' : 'Date'));
    if (shaShown()) header.appendChild(col('', 'SHA'));
  }

  /**
   * Badges of a row: a local branch and its remote counterpart at the same commit share one
   * badge (branch + cloud icon), like most git UIs do.
   */
  function groupRefs(r) {
    const shown = [];
    const locals = new Map();
    for (const ref of r.refs) {
      if (ref.type === 'branch') {
        const entry = { ref, remotes: [] };
        locals.set(ref.name, entry);
        shown.push(entry);
      }
    }
    const hasHeadBranch = r.refs.some((x) => x.isHead);
    for (const ref of r.refs) {
      if (ref.type === 'branch') continue;
      if (ref.type === 'head' && hasHeadBranch) continue;
      // git bisect's own markers (refs/bisect/*) are not branches: the bisect status shows them.
      if (ref.type === 'other' && /^bisect\//.test(ref.name)) continue;
      if (ref.type === 'internal') continue; // a fetched PR's merge/base bookkeeping refs
      if (ref.type === 'remote') {
        const local = locals.get(ref.name.slice(ref.name.indexOf('/') + 1));
        if (local) {
          local.remotes.push(ref.name);
          continue;
        }
      }
      shown.push({ ref, remotes: [] });
    }
    // main / master first (by design: never hidden in "+N"), then the current branch,
    // local branches, remote branches (origin/main first), tags.
    const short = (e) => (e.ref.type === 'remote' ? e.ref.name.slice(e.ref.name.indexOf('/') + 1) : e.ref.name);
    const isDefault = (e) => (e.ref.type === 'branch' || e.ref.type === 'remote') && /^(main|master)$/.test(short(e));
    const rank = (e) => {
      if (isDefault(e)) return e.ref.type === 'branch' ? 0 : 1;
      if (e.ref.isHead) return 2;
      return { branch: 3, head: 3, remote: 4, tag: 5 }[e.ref.type] || 6;
    };
    // Within a rank by name ("aaa" before "release/…").
    return shown.sort((a, b) => rank(a) - rank(b) || a.ref.name.localeCompare(b.ref.name));
  }

  /** main / master (local or remote): shown on a row even when the others fold into "+N". */
  function isDefaultRef(ref) {
    const name = ref.type === 'remote' ? ref.name.slice(ref.name.indexOf('/') + 1) : ref.name;
    return (ref.type === 'branch' || ref.type === 'remote') && /^(main|master)$/.test(name);
  }

  function refBadge(r, ref, remotes = []) {
    const isCurrent = ref.isHead || (ref.type === 'branch' && head && head.branch === ref.name);
    const b = el('span', `ref ref-${ref.type}${isCurrent ? ' current' : ''}${isDefaultRef(ref) ? ' default-ref' : ''}`);
    const iconName = ref.type === 'tag' ? 'tag' : ref.type === 'remote' ? 'cloud' : ref.type === 'head' ? 'target' : ref.type === 'pr' ? 'pr' : isCurrent ? 'check' : 'branch';
    // Sidebar: the last part of a folder-style name ("agent/task" -> "task"); the full name is
    // in the tooltip and the row's label.
    const shown = settings.compact && ref.type !== 'pr' ? ref.name.split('/').pop() || ref.name : ref.name;
    b.append(ui.icon(iconName, { size: 12 }), el('span', 'ref-name', shown));
    // Short names keep their width; the long ones are what gives way.
    if (shown.length <= 12) b.classList.add('ref-short');
    if (remotes.length) b.appendChild(ui.icon('cloud', { size: 12, cls: 'ref-also' }));
    if (isCurrent && head && (head.ahead || head.behind)) {
      b.appendChild(el('span', 'ref-counts', `${head.ahead ? `↑${head.ahead}` : ''}${head.behind ? `↓${head.behind}` : ''}`));
    }
    const kind = ref.type === 'remote' ? 'Remote branch' : ref.type === 'tag' ? 'Tag' : ref.type === 'head' ? 'HEAD (detached)' : ref.type === 'pr' ? `Pull request (fetched from ${ref.remote}):` : 'Branch';
    b.title = `${kind} ${ref.name}${isCurrent ? ' (checked out)' : ''}${remotes.length ? `\nAlso here: ${remotes.join(', ')}` : ''}${isCurrent && head && head.upstream ? `\nUpstream: ${head.upstream} (${head.ahead || 0} ahead, ${head.behind || 0} behind)` : ''}`;
    if (ref.type !== 'head' && ref.type !== 'pr') {
      b.dataset.vscodeContext = JSON.stringify({ webviewSection: 'ref', surface: settings.surface, ref: ref.rev || ref.name, refType: ref.type, sha: r.sha, isCurrent, preventDefaultContextMenuItems: true });
    }
    return b;
  }

  /** The selected SHAs in list order. */
  function selectionList() {
    return rows.filter((r) => selected.has(r.sha)).map((r) => r.sha);
  }

  /**
   * Context-menu data of a commit row. A multi-selection travels along, so a menu command acts
   * on what is selected now, not on what the host last heard about (selection updates are debounced).
   */
  function commitContext(r, selList) {
    const multi = selected.size > 1 && selected.has(r.sha);
    const sel = multi ? selList() : undefined;
    // onHead: the commit is in the current branch's history — only then do history rewrites
    // (reword, squash, fixup, drop) make sense in the menu.
    // Unknown (a search shows only matches, a filter may hide HEAD): offered; the commands
    // themselves check that the commit is in the current branch.
    const mine = headHistory();
    const on = (sha) => !mine || mine.has(sha);
    // Mark All Files as Viewed / Not Viewed: only the one that applies (by its known count).
    const vc = viewedCounts.get(r.sha);
    const viewedAll = !multi && !!vc && vc[0] >= vc[1];
    const viewedAny = multi || (!!vc && vc[0] > 0);
    return JSON.stringify({ webviewSection: 'commit', surface: settings.surface, sha: r.sha, multi, wip: !!wipBySha[r.sha], onHead: on(r.sha), viewedAll, viewedAny, ...(multi ? { selection: sel, allOnHead: sel.every(on) } : {}), preventDefaultContextMenuItems: true });
  }

  /** The loaded commits reachable from HEAD (worked out again when rows or HEAD change). */
  let headHistoryCache = { key: '', set: new Set() };
  function headHistory() {
    const tip = head && head.sha;
    // Only the full history (no search) with HEAD in it tells which commits are HEAD's.
    if (!tip || !indexBySha.has(tip) || searchBox.dataset.active === '1') return undefined;
    const key = `${tip}|${rows.length}|${dataVersion}`;
    if (headHistoryCache.key === key) return headHistoryCache.set;
    const set = new Set();
    const todo = tip ? [tip] : [];
    while (todo.length) {
      const sha = todo.pop();
      if (set.has(sha) || !indexBySha.has(sha)) continue;
      set.add(sha);
      for (const p of rows[indexBySha.get(sha)].parents || []) todo.push(p);
    }
    headHistoryCache = { key, set };
    return set;
  }

  let lastView = '';
  /** Commits that just arrived, until they stop glowing. */
  const arrived = new Set();
  function markArrived(shas) {
    if (!shas.length || shas.length > 50) return; // a whole new history is not "arriving"
    for (const sha of shas) arrived.add(sha);
    setTimeout(() => {
      for (const sha of shas) arrived.delete(sha);
      for (const [i, entry] of live) entry.el.classList.toggle('arrived', arrived.has(rows[i] && rows[i].sha));
    }, 4000);
  }

  /** Selection/search state of a row; updated in place so DOM nodes survive re-renders (double-click works). */
  function updateRowState(div, i, selList = selectionList) {
    const r = rows[i];
    div.classList.toggle('selected', selected.has(r.sha));
    div.setAttribute('aria-selected', selected.has(r.sha) ? 'true' : 'false');
    div.classList.toggle('cursor', i === cursor);
    div.classList.toggle('arrived', arrived.has(r.sha));
    div.classList.toggle('match', !!highlight && matchSet.has(i));
    div.classList.toggle('dim', !!highlight && !matchSet.has(i));
    if (r.sha !== WORKTREE_SHA) div.dataset.vscodeContext = commitContext(r, selList);
    // Screen readers read the active option itself: everything the row shows, when and who first.
    div.setAttribute('aria-label', rowLabel(i));
    div.setAttribute('aria-setsize', String(rows.length));
    div.setAttribute('aria-posinset', String(i + 1));
  }

  /** Spoken text of a row. */
  function rowLabel(i) {
    const r = rows[i];
    if (r.sha === WORKTREE_SHA) return r.subject || 'Working changes';
    const range = bucketStarts.get(i);
    const refs = r.refs.filter((x) => x.type !== 'head').map((x) => x.name).join(', ');
    const st = stats.get(r.sha);
    const w = wipBySha[r.sha];
    const wip = w ? `, worktree ${w.name} has uncommitted changes` : '';
    return `${range ? `${range}: ` : ''}${isNew(r) ? 'new, ' : ''}${ui.longAge(rowDate(r))}, ${r.author}${isMe(r.email) ? ' (you)' : ''}: ${r.subject}${refs ? `, ${refs}` : ''}${st && st[0] ? `, ${st[0]} file${st[0] === 1 ? '' : 's'}, ${st[1]} added, ${st[2]} deleted` : ''}${wip}`;
  }

  /** Rows committed after this (ms) are marked new; set by the host for the sidebar. */
  let newSince = 0;
  /** New since you last looked, and not your own (you know what you committed). */
  const isNew = (r) => !!newSince && rowDate(r) > newSince && !isMe(r.email);

  /** The date a row is dated by: commit date in the sidebar (its order), author date in the editor graph. */
  const rowDate = (r) => r.cdate || r.date;

  function renderRow(i, selList) {
    const r = rows[i];
    const div = el('div', 'row');
    div.style.top = `${rowTop(i)}px`;
    div.dataset.index = String(i);
    div.id = `row-${i}`;
    div.setAttribute('role', 'treeitem');
    div.setAttribute('aria-level', '1');
    if (head && head.sha === r.sha) div.classList.add('is-head');
    if (r.sha === WORKTREE_SHA) div.classList.add('worktree');
    updateRowState(div, i, selList);

    const graphCell = el('div', 'cell graph');
    graphCell.appendChild(drawGraph(r));
    if (settings.compact) return renderCompactRow(div, graphCell, r, i);
    const desc = el('div', 'cell desc');
    desc.appendChild(twistyFor(div, i));
    if (r.sha === WORKTREE_SHA) {
      desc.append(el('span', 'subject wt-label', 'Uncommitted changes'), el('span', 'wt-summary', worktreeSummary(r.wt)));
      const vc = viewedBadge(r.sha);
      if (vc) desc.appendChild(vc);
      desc.title = 'Enter or double-click opens Source Control';
    } else {
      // HEAD -> branch: only the branch is shown; bare HEAD only when detached.
      // Up to three in full, fewer when the column is narrow (main / master always among them),
      // the rest as "+N" (tooltip lists them): a long row of shrunken badges would leave each one
      // unreadable, and the message would get no room.
      const refs = groupRefs(r);
      const room = badgeRoom();
      const full = refs.filter((x, k) => k < room || isDefaultRef(x.ref));
      for (const { ref, remotes } of full) desc.appendChild(refBadge(r, ref, remotes));
      const rest = refs.filter((x) => !full.includes(x));
      if (rest.length) {
        const more = el('span', 'ref ref-more', `+${rest.length}`);
        more.title = rest.map((x) => x.ref.name).join('\n');
        desc.appendChild(more);
      }
      const wip = wipChip(r);
      if (wip) desc.appendChild(wip);
      desc.appendChild(el('span', 'subject', r.subject));
      const vc = viewedBadge(r.sha);
      if (vc) desc.appendChild(vc);
    }
    div.append(graphCell, desc);
    if (settings.showAuthor) {
      const a = el('div', 'cell author');
      if (r.sha !== WORKTREE_SHA) a.append(ui.avatar(r.author, r.email, 16), el('span', 'author-name', isMe(r.email) ? `${r.author} (you)` : r.author));
      a.title = r.email ? `${r.author} <${r.email}>` : r.author || '';
      div.appendChild(a);
    }
    if (settings.showChanges) {
      const ch = el('div', 'cell changes');
      fillChanges(ch, r.sha);
      div.appendChild(ch);
    }
    if (settings.showDate) {
      const d = el('div', 'cell date', r.sha === WORKTREE_SHA ? '' : fmtDate(rowDate(r)));
      if (r.date && r.sha !== WORKTREE_SHA) {
        d.title = `Committed ${ui.longAge(rowDate(r))} — ${ui.fullDate(rowDate(r))}`;
        if (Math.abs(rowDate(r) - r.date) > 36e5) d.title += `\nAuthored ${ui.longAge(r.date)} — ${ui.fullDate(r.date)}`;
      }
      div.appendChild(d);
    }
    if (shaShown()) div.appendChild(el('div', 'cell sha', r.sha === WORKTREE_SHA ? '' : short(r.sha)));
    return div;
  }

  /** ▸ / ▾ of a row: shows its changed files (a commit's, or the uncommitted ones) under it. */
  function twistyFor(div, i) {
    const open = isExpanded(i);
    const twisty = el('span', `twisty${open ? ' open' : ''}`);
    twisty.appendChild(ui.icon('chevron', { size: 12 }));
    twisty.title = open ? 'Hide the changed files (←)' : 'Show the changed files (→)';
    twisty.addEventListener('mousedown', (ev) => {
      ev.stopPropagation(); // not a selection click
      ev.preventDefault();
    });
    twisty.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleExpanded(i);
    });
    div.setAttribute('aria-expanded', open ? 'true' : 'false');
    // Its file group is rendered as a sibling (rows are absolutely placed); own it for the tree.
    if (open) div.setAttribute('aria-owns', `files-${i}`);
    return twisty;
  }

  /** Sidebar row: lanes, age, avatar, change bar, then badges and message. */
  function renderCompactRow(div, graphCell, r, i) {
    const wt = r.sha === WORKTREE_SHA;
    const d = rowDate(r);
    const when = el('div', 'cell date', wt ? '' : settings.dateFormat === 'relative' ? ui.tinyAge(d) : ui.shortDate(d));
    // Committed while you were away (since you last looked away from the graph), by someone else.
    if (!wt && isNew(r)) {
      div.classList.add('new');
      when.prepend(el('span', 'new-dot'));
    }
    if (!wt) {
      when.title = `Committed ${ui.longAge(d)} — ${ui.fullDate(d)}`;
      if (Math.abs(d - r.date) > 36e5) when.title += `\nAuthored ${ui.longAge(r.date)} — ${ui.fullDate(r.date)}`;
    }
    const who = el('div', 'cell who');
    if (!wt) {
      who.appendChild(ui.avatar(r.author, r.email, 18));
      who.title = `${r.author}${isMe(r.email) ? ' (you)' : ''}${r.email ? ` <${r.email}>` : ''}`;
    }
    const ch = el('div', 'cell changes');
    fillChanges(ch, r.sha, true);
    const desc = el('div', 'cell desc');
    // ▸ / ▾: show this commit's changed files under it (→ / ← on the keyboard); first, right
    // after the lanes, so the files below line up under it.
    const expander = el('div', 'cell expander');
    expander.appendChild(twistyFor(div, i));
    if (wt) {
      // Like a commit row: a message and a short summary; ▸ shows the files (collapsed by
      // default), Enter/click opens Source Control, where staging happens.
      const label = el('span', 'subject wt-label', 'Uncommitted changes');
      const summary = el('span', 'wt-summary', worktreeSummary(r.wt));
      // A click on the words opens Source Control (staging happens there); ▸ shows the files.
      for (const part of [label, summary]) {
        part.addEventListener('click', (ev) => {
          ev.stopPropagation();
          vscode.postMessage({ type: 'openCommit', sha: WORKTREE_SHA });
        });
      }
      desc.append(label, summary);
      const vc = viewedBadge(r.sha);
      if (vc) desc.appendChild(vc);
      desc.title = `${r.subject || 'Uncommitted changes'} — click or Enter opens Source Control, ▸ or → shows the files`;
    }
    else {
      // The message needs the room: one badge (the most important) and main / master, the
      // rest as "+N".
      const refs = groupRefs(r);
      const shownRefs = refs.filter((x, k) => k === 0 || isDefaultRef(x.ref));
      for (const x of shownRefs) desc.appendChild(refBadge(r, x.ref, x.remotes));
      const wip = wipChip(r);
      if (wip) desc.appendChild(wip);
      const rest = refs.filter((x) => !shownRefs.includes(x));
      if (rest.length) {
        const more = el('span', 'ref ref-more', `+${rest.length}`);
        more.title = rest.map((x) => x.ref.name).join('\n');
        desc.appendChild(more);
      }
      desc.appendChild(el('span', 'subject', r.subject));
      const vc = viewedBadge(r.sha);
      if (vc) desc.appendChild(vc);
    }
    if (wt) {
      // No age, avatar or bar: its summary gets their room.
      desc.style.gridColumn = '3 / -1';
      div.append(graphCell, expander, desc);
    } else div.append(graphCell, expander, when, who, ch, desc);
    return div;
  }

  /** Time ranges shown as labelled lines in the sidebar (row index -> label). */
  let bucketStarts = new Map();
  const BUCKETS = ['Today', 'Yesterday', 'This week', 'This month', 'Older'];
  function bucketOf(ms, now = new Date()) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ms >= day) return 0;
    if (ms >= day - 864e5) return 1;
    if (ms >= day - 6 * 864e5) return 2;
    if (ms >= day - 29 * 864e5) return 3;
    return 4;
  }
  /** Ranges never go back in time down the list (branches interleave in topological order). */
  function computeBuckets() {
    bucketStarts = new Map();
    sepCount = new Int32Array(0);
    // By date (the sidebar, or commitCorner.graph.order "date"): each row in its own range.
    // In topological order dates are not sorted: the headings follow the oldest commit so far,
    // so each appears once and in order (a newer commit of an interleaved branch stays under
    // the heading it is shown in; its own date is in its row).
    const monotone = !settings.compact && !settings.dateOrder;
    let current = -1;
    let oldest = Infinity;
    sepCount = new Int32Array(rows.length + 1);
    let n = 0;
    rows.forEach((r, i) => {
      if (r.sha !== WORKTREE_SHA) {
        oldest = Math.min(oldest, rowDate(r));
        // Each row sits in its own range: if an older branch interleaves, the range repeats
        // rather than mislabelling rows.
        const b = bucketOf(monotone ? oldest : rowDate(r));
        if (b !== current) {
          bucketStarts.set(i, BUCKETS[b]);
          n++;
        }
        current = b;
      }
      sepCount[i] = n;
    });
    sepCount[rows.length] = n;
  }

  /** "Last 7 days: 23 commits · 3 people · +1.2k −340" */
  function renderSummary(a) {
    summaryBar.replaceChildren();
    summaryBar.hidden = !settings.compact || !a;
    if (!a) return;
    summaryBar.append(ui.icon('graph'), el('span', 'strong', `${a.days} days`));
    if (!a.commits) summaryBar.append(el('span', 'dim', 'no commits'));
    else {
      summaryBar.append(
        el('span', '', `${a.commits} commit${a.commits === 1 ? '' : 's'}`),
        el('span', '', `${a.authors} ${a.authors === 1 ? 'person' : 'people'}`),
        el('span', 'add', `+${ui.compact(a.added)}`),
        el('span', 'del', `−${ui.compact(a.deleted)}`),
      );
    }
    summaryBar.title = 'Open Repository Activity';
    summaryBar.setAttribute('aria-label', `Last ${a.days} days: ${a.commits} commits by ${a.authors} ${a.authors === 1 ? 'person' : 'people'}, ${a.added} lines added, ${a.deleted} deleted. Open Repository Activity.`);
  }

  const isMe = (email) => !!me && !!email && email.toLowerCase() === me.toLowerCase();

  /** Chips of the working-tree row: staged, unstaged, untracked, conflicts. */
  /** "3 files · 1 staged" — a short, quiet summary for the uncommitted-changes row. */
  function worktreeSummary(wt) {
    if (!wt) return '';
    const total = (wt.staged || 0) + (wt.unstaged || 0) + (wt.untracked || 0) + (wt.conflicts || 0);
    if (!total) return 'clean'; // shown while its staging area is open after a commit
    const parts = [`${total} file${total === 1 ? '' : 's'}`];
    if (wt.conflicts) parts.push(`${wt.conflicts} conflicted`);
    if (wt.staged) parts.push(`${wt.staged} staged`);
    return parts.join(' · ');
  }

  function worktreeChips(wt) {
    if (!wt) return [];
    const chips = [];
    const chip = (cls, iconName, n, label) => {
      if (!n) return;
      const c = el('span', `chip ${cls}`);
      c.append(ui.icon(iconName, { size: 12 }), el('span', '', String(n)));
      c.title = `${n} ${label}`;
      chips.push(c);
    };
    chip('chip-conflict', 'warning', wt.conflicts, 'with conflicts');
    chip('chip-staged', 'check', wt.staged, 'staged');
    chip('chip-unstaged', 'edit', wt.unstaged, 'changed, not staged');
    chip('chip-untracked', 'plus', wt.untracked, 'untracked');
    return chips;
  }

  /** The Changes cell: a +/− bar and counts once known, a placeholder until then. */
  function fillChanges(cell, sha, barOnly = settings.compact || root.classList.contains('xtight')) {
    cell.replaceChildren();
    if (sha === WORKTREE_SHA) return;
    const st = stats.get(sha);
    if (!st) {
      cell.appendChild(el('span', 'pending', '·'));
      return;
    }
    const [files, added, deleted] = st;
    if (!files) {
      cell.appendChild(el('span', 'pending', 'empty'));
      cell.title = 'No file changes';
      return;
    }
    if (barOnly) cell.append(ui.statBar(added, deleted, root.classList.contains('narrow') ? 18 : 26));
    else cell.append(ui.statBar(added, deleted, 36), el('span', 'add', `+${ui.compact(added)}`), el('span', 'del', `−${ui.compact(deleted)}`));
    cell.title = `${files} file${files === 1 ? '' : 's'} changed, ${added} addition${added === 1 ? '' : 's'}, ${deleted} deletion${deleted === 1 ? '' : 's'}`;
  }

  let statsTimer;
  /** Ask the host for the stats of rows on screen that have none yet (batched). */
  function requestStats(first, last) {
    if (!settings.showChanges) return;
    clearTimeout(statsTimer);
    statsTimer = setTimeout(() => {
      const shas = [];
      for (let i = Math.max(0, first); i <= last && i < rows.length; i++) {
        const sha = rows[i].sha;
        if (sha !== WORKTREE_SHA && !stats.has(sha) && !statsRequested.has(sha)) shas.push(sha);
      }
      if (!shas.length) return;
      shas.forEach((sha) => statsRequested.add(sha));
      vscode.postMessage({ type: 'stats', shas });
    }, 60);
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  /** index -> {el, version}: rendered rows, reused across renders. */
  const live = new Map();
  let dataVersion = 0;
  let moreEl = null;

  /** Separators (time ranges) at or above each row: sepCount[i]. Empty in the editor graph. */
  let sepCount = new Int32Array(0);
  /** File lines of expanded commits above each row (sidebar): lineCount[i]. */
  let lineCount = new Int32Array(0);
  function rowTop(i) {
    const n = sepCount.length ? sepCount[Math.min(i, sepCount.length - 1)] : 0;
    const l = lineCount.length ? lineCount[Math.min(i, lineCount.length - 1)] : 0;
    return i * ROW_H + n * SEP_H + l * FILE_H;
  }

  // ---------------------------------------------------------------- expanded commits (sidebar)

  /** Height of one line of an expanded commit's file tree. */
  const FILE_H = 20;
  /** sha -> {files?: object[], parent?: string, error?: string}: commits shown with their files. */
  const expanded = new Map();
  /** index -> element with the file tree under that row, like `live`. */
  const liveFiles = new Map();
  /** The repository on the page (from the last `data`): staging names it, late answers are dropped. */
  let repoRoot;

  /** A new expanded entry; the uncommitted changes get back the message typed before. */
  function newEntry(sha) {
    if (sha !== WORKTREE_SHA) return {};
    const d = saved.wtDraft;
    return { draft: d && d.repoRoot === repoRoot && typeof d.text === 'string' ? d.text : '' };
  }

  /** The commit message is kept with the page state: hiding the view or reloading keeps it. */
  function saveDraft(text) {
    persist({ wtDraft: { repoRoot, text } });
    // One draft with Source Control's message box (after a short pause in typing).
    clearTimeout(saveDraft.timer);
    saveDraft.timer = setTimeout(() => {
      saveDraft.timer = undefined;
      saveDraft.sent = text;
      vscode.postMessage({ type: 'draftChanged', repoRoot, text });
    }, 400);
  }

  /**
   * The draft as Source Control or the other graph has it now: this box takes it over — unless
   * it is what this box sent itself (a commit since may have used it up), you are typing here
   * (not sent yet), or ✨ is writing.
   */
  function takeDraft(text) {
    const e = expanded.get(WORKTREE_SHA);
    if (typeof text !== 'string' || text === saveDraft.sent || saveDraft.timer || !e || e.generating || e.busy || text === (e.draft || '')) return;
    saveDraft.sent = text;
    const before = commitBoxLines(e).length;
    e.draft = text;
    if (e.commitEl) /** @type {HTMLTextAreaElement} */ (e.commitEl.querySelector('.commit-message')).value = text;
    persist({ wtDraft: { repoRoot, text } });
    if (commitBoxLines(e).length !== before) {
      e.lines = undefined;
      relayout();
    }
  }

  /** Lines the commit box takes: its message (1–5 lines, as typed) and its buttons. */
  function commitBoxLines(e) {
    const n = Math.min(5, ((e && e.draft) || '').split('\n').length);
    return [{ kind: 'commit', depth: 0 }, ...Array.from({ length: n }, () => ({ kind: 'pad', depth: 0 }))];
  }

  /** The lines under row i: its file tree (folders and files), or one "loading" line. */
  function expansionLines(i) {
    const e = rows[i] && expanded.get(rows[i].sha);
    if (!e) return [];
    if (!e.files) return [{ kind: 'note', text: e.error || 'Loading files…', depth: 0 }];
    if (!e.files.length) {
      return rows[i].sha === WORKTREE_SHA
        ? [...commitBoxLines(e), { kind: 'note', text: 'No uncommitted changes', depth: 0 }]
        : [{ kind: 'note', text: 'No files changed', depth: 0 }];
    }
    if (!e.collapsed) e.collapsed = new Set();
    if (!e.lines) {
      if (rows[i].sha === WORKTREE_SHA) {
        // Uncommitted changes: a commit box, then the groups as in Source Control, each a folder
        // of its own with its actions (stage, unstage, discard), so all of it happens right here.
        const groups = [['merge', 'Merge conflicts'], ['staged', 'Staged'], ['unstaged', 'Changes'], ['untracked', 'Untracked']];
        e.lines = commitBoxLines(e);
        for (const [g, label] of groups) {
          const files = e.files.filter((f) => f.group === g);
          if (!files.length) continue;
          const key = `#${g}`;
          const open = !e.collapsed.has(key);
          e.lines.push({ kind: 'folder', text: `${label} (${files.length})`, depth: 0, key, open, group: g });
          if (open) e.lines.push(...fileTreeLines(files, e.collapsed, 1, `${key}/`));
        }
      } else e.lines = fileTreeLines(e.files, e.collapsed);
    }
    return e.lines;
  }

  /**
   * A folder tree as lines: single-child folders are joined ("src/vscode/views"), folders
   * before files, both sorted by name.
   */
  function fileTreeLines(files, collapsed = new Set(), baseDepth = 0, keyPrefix = '') {
    const root = { dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = f.path.split('/');
      let node = root;
      for (const part of parts.slice(0, -1)) {
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      }
      node.files.push({ name: parts[parts.length - 1], file: f });
    }
    const lines = [];
    const walk = (node, depth, prefix) => {
      for (const [name, child] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0], 'en'))) {
        let label = name;
        let c = child;
        while (c.dirs.size === 1 && !c.files.length) {
          const [[n, cc]] = [...c.dirs];
          label += `/${n}`;
          c = cc;
        }
        const key = `${keyPrefix}${prefix}${label}`;
        const open = !collapsed.has(key);
        lines.push({ kind: 'folder', text: label, depth, key, open });
        // A collapsed folder hides what is in it (▸), like any tree.
        if (open) walk(c, depth + 1, `${prefix}${label}/`);
      }
      for (const f of node.files.sort((a, b) => a.name.localeCompare(b.name, 'en'))) lines.push({ kind: 'file', text: f.name, file: f.file, depth });
    };
    walk(root, baseDepth, '');
    return lines;
  }

  /** Recompute the line offsets after expanding or collapsing (or new rows). */
  function computeLines() {
    lineCount = new Int32Array(rows.length + 1);
    let n = 0;
    for (let i = 0; i < rows.length; i++) {
      lineCount[i] = n;
      n += expansionLines(i).length;
    }
    lineCount[rows.length] = n;
  }

  function isExpanded(i) {
    return !!(rows[i] && expanded.has(rows[i].sha));
  }

  /** Show or hide a commit's changed files under its row. */
  function toggleExpanded(i, open = !isExpanded(i)) {
    const r = rows[i];
    if (!r || open === isExpanded(i)) return;
    if (open) {
      expanded.set(r.sha, newEntry(r.sha));
      vscode.postMessage({ type: 'files', sha: r.sha });
    } else {
      expanded.delete(r.sha);
      if (r.sha === WORKTREE_SHA) vscode.postMessage({ type: 'filesClosed', sha: r.sha });
    }
    // Kept when the view is hidden and shown again (the webview is re-created then).
    persist({ expanded: [...expanded.keys()].slice(-20) });
    relayout();
    announcer.textContent = open ? 'Expanded: changed files' : 'Collapsed';
  }

  /** Collapse All (title bar, toolbar): every expanded commit, and the staging area, closes. */
  function collapseAll() {
    if (!expanded.size) return;
    const hadFiles = document.activeElement && document.activeElement.closest && document.activeElement.closest('.files-block');
    if (expanded.has(WORKTREE_SHA)) vscode.postMessage({ type: 'filesClosed', sha: WORKTREE_SHA });
    expanded.clear();
    persist({ expanded: [] });
    relayout();
    if (hadFiles) scroller.focus();
    announcer.textContent = 'All commits collapsed';
  }

  /** Everything below a changed row moves: re-create the visible rows at their new places. */
  function relayout() {
    computeLines();
    dataVersion++;
    render();
  }

  /** The file tree under row i, with the lanes passing through on the left. */
  function renderFiles(i) {
    const lines = expansionLines(i);
    const r = rows[i];
    const box = el('div', 'files-block');
    box.style.top = `${rowTop(i) + ROW_H}px`;
    box.style.height = `${lines.length * FILE_H}px`;
    box.id = `files-${i}`;
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', `Files changed in ${r.subject || 'the working tree'}`);
    const lanes = document.createElementNS(SVG_NS, 'svg');
    // As wide as the rows' lane column, so the file tree lines up with the commit's ▸.
    lanes.setAttribute('width', String(graphWidth() - (settings.compact ? 3 : 0)));
    lanes.setAttribute('height', String(lines.length * FILE_H));
    lanes.setAttribute('class', 'graph-svg files-lanes');
    for (const l of r.g.lines) {
      // Lines leaving row i downwards continue past its files.
      if (l.kind !== 'pass' && l.kind !== 'out') continue;
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', `M${x(l.to)} 0V${lines.length * FILE_H}`);
      p.setAttribute('class', `lane c${l.color}`);
      lanes.appendChild(p);
    }
    const list = el('div', 'files-lines');
    const e = expanded.get(r.sha);
    const wt = r.sha === WORKTREE_SHA;
    for (const line of lines) {
      if (line.kind === 'pad') continue; // the commit box is several lines high
      if (line.kind === 'commit') {
        list.appendChild(commitBox(e));
        continue;
      }
      const div = el('div', `file-line ${line.kind}`);
      div.style.paddingLeft = `${fileIndent(line.depth)}px`;
      if (line.kind === 'note') div.appendChild(el('span', 'dim', line.text));
      else if (line.kind === 'folder') {
        // A folder (or a Staged/Changes group): ▾/▸ collapses and expands it, by click or keys.
        const chev = el('span', `twisty${line.open ? ' open' : ''}`);
        chev.appendChild(ui.icon('chevron', { size: 11 }));
        div.append(chev, ui.icon('folder', { size: 12 }), el('span', 'name', line.text));
        div.tabIndex = -1;
        div.dataset.key = line.key;
        div.setAttribute('role', 'treeitem');
        div.setAttribute('aria-level', String(line.depth + 2));
        div.setAttribute('aria-expanded', line.open ? 'true' : 'false');
        div.setAttribute('aria-label', `${line.group ? '' : 'Folder '}${line.text}`);
        const toggle = () => toggleFolder(i, line.key);
        div.addEventListener('click', toggle);
        const inGroup = wt && !line.group && /^#(\w+)\/(.+)$/.exec(line.key);
        const acts = wt && line.group ? groupActions(i, line.group) : inGroup ? folderActions(i, inGroup[1], inGroup[2]) : undefined;
        if (acts) div.appendChild(acts.el);
        div.addEventListener('keydown', (ev) => onFileKey(ev, div, i, toggle, line, acts));
      } else {
        const f = line.file;
        const s = f.status === '!' ? '!' : (f.status || 'M')[0];
        const status = el('span', `status s-${s === '!' ? 'conflict' : s}`, s);
        div.append(status, el('span', 'name', line.text));
        if (f.added !== undefined && f.added !== null) div.appendChild(ui.statBar(f.added, f.deleted || 0, 22));
        div.tabIndex = -1;
        div.setAttribute('role', 'treeitem');
        div.setAttribute('aria-level', String(line.depth + 2)); // under its folders
        const what = ({ A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Untracked', '!': 'Conflict' })[s] || 'Changed';
        const lineInfo = f.added !== undefined && f.added !== null ? `, ${f.added} added, ${f.deleted} deleted` : '';
        div.setAttribute('aria-label', `${what} ${f.path}${lineInfo}`);
        div.title = `${what}: ${f.origPath && f.origPath !== f.path ? `${f.origPath} → ` : ''}${f.path}${lineInfo.replace(/^, /, ' — ')}\n${fileKeysHint(wt)}`;
        // keep: Space previews and leaves the keyboard here (step through files); Enter/click go there.
        const open = (keep) => vscode.postMessage(r.sha === WORKTREE_SHA
          ? { type: 'openFile', kind: 'worktree', file: f, keepFocus: keep === true }
          : { type: 'openFile', kind: 'commit', file: f, sha: r.sha, parent: e && e.parent, keepFocus: keep === true });
        div.addEventListener('click', () => open(false));
        const acts = wt ? fileActions(i, f) : undefined;
        if (acts) {
          div.appendChild(acts.el);
          div.setAttribute('aria-label', `${div.getAttribute('aria-label')}, ${f.group === 'staged' ? 'staged' : f.group === 'merge' ? 'conflicted' : 'not staged'}. ${acts.hint}`);
        }
        div.dataset.fkey = `${f.group || ''}:${f.path}`;
        decorateFile(div, f, r.sha, e && e.parent);
        if (!wt) {
          const ca = commitFileActions(r.sha, f, e && e.parent);
          div.appendChild(ca.el);
          div.setAttribute('aria-label', `${div.getAttribute('aria-label')}. ${ca.hint}`);
        } else if (acts) acts.el.prepend(actButton('goToFile', 'Open the working file (O)', () => fileAction('openWorking', r.sha, f)));
        div.addEventListener('keydown', (ev) => {
          if (fileKey(ev, r.sha, f, e && e.parent, div)) return;
          onFileKey(ev, div, i, open, undefined, acts);
        });
      }
      list.appendChild(div);
    }
    box.append(lanes, list);
    return box;
  }

  /**
   * Keys on a file line: ↑/↓ between files, Enter opens, ←/Esc back to the commit (still
   * expanded), Tab on to the next control. File lines sit inside the commit list, so their keys
   * stop here: the list's own keys (Enter opens the commit, ↓ moves the commit cursor, Tab
   * enters the files) must not run as well. Ctrl/Cmd chords (search, …) still reach the list.
   */
  function onFileKey(ev, div, i, open, folder, acts) {
    if (chordKeys.has(ev)) return; // the second key of a VS Code chord (Ctrl+Alt+G S…)
    // Keys used here are taken (preventDefault); the list skips keys from inside a files block
    // (see its handler), and everything else (F1, the second key of a VS Code chord) goes on.
    const files = [...div.parentElement.querySelectorAll('.file-line.file, .file-line.folder')];
    const k = files.indexOf(div);
    // Uncommitted changes: + / s stages, - / u unstages, Delete / d discards (the file or group).
    if (acts && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key; // S, U, D too
      const run = (fn) => {
        ev.preventDefault();
        rememberFocus(i, k, div);
        fn();
      };
      if ((key === '+' || key === 's') && acts.stage) return run(acts.stage);
      if ((key === '-' || key === 'u') && acts.unstage) return run(acts.unstage);
      if ((key === 'Delete' || key === 'd') && acts.discard) return run(acts.discard);
    }
    // Folders: Enter/Space toggle, → opens (or steps in), ← closes (or goes back to the commit).
    if (folder && (ev.key === 'ArrowRight' || ((ev.key === 'Enter' || ev.key === ' ') && folder.open !== undefined))) {
      ev.preventDefault();
      if (ev.key === 'ArrowRight' && folder.open) {
        if (files[k + 1]) files[k + 1].focus();
      } else open();
      return;
    }
    if (folder && ev.key === 'ArrowLeft' && folder.open) {
      ev.preventDefault();
      open();
      return;
    }
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      open(ev.key === ' ');
    } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const next = files[k + (ev.key === 'ArrowDown' ? 1 : -1)];
      const message = ev.key === 'ArrowUp' && div.parentElement.querySelector('.commit-message');
      if (next) next.focus();
      else if (message) message.focus(); // above the uncommitted files: their commit message
      else {
        // Like a tree: past the last file to the next commit, above the first to this one.
        selectIndex(Math.min(rows.length - 1, ev.key === 'ArrowDown' ? i + 1 : i));
        scroller.focus();
      }
    } else if (ev.key === 'Home' || ev.key === 'End') {
      ev.preventDefault();
      files[ev.key === 'Home' ? 0 : files.length - 1].focus();
    } else if (ev.key === 'ArrowLeft' && Number(div.getAttribute('aria-level')) > 2) {
      // Inside a folder (or group): ← goes to it, as in a tree.
      ev.preventDefault();
      const level = Number(div.getAttribute('aria-level'));
      const parent = files.slice(0, k).reverse().find((x) => Number(x.getAttribute('aria-level')) < level);
      if (parent) parent.focus();
    } else if (ev.key === 'ArrowLeft' || ev.key === 'Escape') {
      ev.preventDefault();
      cursor = i;
      scroller.focus();
      cursorChanged();
    }
  }

  // ------------------------------------------------ uncommitted changes: staging in the graph

  /**
   * VS Code's chords start with Ctrl+Alt+G: the key after it is VS Code's (it reaches VS Code all
   * the same), never a letter in the message or a staging key here (Ctrl+Alt+G S must not stage).
   */
  const chordKeys = new WeakSet();
  let chordUntil = 0;
  window.addEventListener('keydown', (e) => {
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    // (Ctrl+Alt+G Ctrl+Alt+G: the second one is the chord's second key, and the chord ends.)
    const g = (e.ctrlKey || e.metaKey) && e.altKey && (e.code === 'KeyG' || e.key.toLowerCase() === 'g');
    if (g && Date.now() >= chordUntil) {
      chordUntil = Date.now() + 1500;
      return;
    }
    if (Date.now() < chordUntil) {
      chordUntil = 0;
      chordKeys.add(e);
      e.preventDefault(); // no character typed; VS Code still sees the key
    }
  }, true);

  /** Run a staging action on the host; the keyboard comes back to the same place afterwards. */
  function wtAction(action, extra = {}) {
    vscode.postMessage({ type: 'wtAction', action, repoRoot, ...extra });
  }

  /**
   * After an action the file list is drawn again: where the keyboard goes then. A file: the next
   * file of its group (else the one before, else the group), as in Source Control; it never
   * lands on another group by position. A group: the same group, if it is still there.
   */
  function rememberFocus(i, k, div) {
    const e = rows[i] && expanded.get(rows[i].sha);
    if (!e) return;
    const prefer = [];
    const fkey = div && div.dataset.fkey;
    if (fkey) {
      const group = fkey.slice(0, fkey.indexOf(':'));
      const path = fkey.slice(group.length + 1);
      const same = [...div.parentElement.querySelectorAll('.file-line.file')].filter((x) => x.dataset.fkey.startsWith(`${group}:`));
      const at = same.indexOf(div);
      for (const x of [...same.slice(at + 1), ...same.slice(0, at).reverse()]) prefer.push({ fkey: x.dataset.fkey });
      prefer.push({ key: `#${group}` });
      // The group is empty now: the file where it went (staged, or back among the changes).
      for (const g of ['staged', 'unstaged', 'untracked']) if (g !== group) prefer.push({ fkey: `${g}:${path}` });
    } else if (div && div.dataset.key) prefer.push({ key: div.dataset.key });
    e.refocus = { index: k, prefer };
  }

  /** The line of a files block named by a refocus preference. */
  function findLine(lines, want) {
    return lines.find((x) => (want.fkey ? x.dataset.fkey === want.fkey : x.dataset.key === want.key));
  }

  /** A small icon button inside a file line (does not open the file, keeps the list's keys). */
  function actButton(iconName, title, fn) {
    const b = el('span', 'file-act');
    b.appendChild(ui.icon(iconName, { size: 12 }));
    b.title = title;
    b.setAttribute('aria-hidden', 'true'); // keys do the same; the line's label names them
    b.addEventListener('mousedown', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
    });
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      fn();
    });
    return b;
  }

  // ------------------------------------------------ any file row: open, compare, viewed

  /** The second line of a file row's tooltip: its keys, naming the base branch once known. */
  function fileKeysHint(wt) {
    const base = compareBaseName || 'the base branch';
    return wt ? `Enter: changes · O: open the file · B: compare with ${base} · N: next not viewed · V: viewed on/off` : `Enter: changes · O: working file · W: compare with the working file · B: compare with ${base} · N: next not viewed · V: viewed on/off`;
  }

  /** Ask the host to do something with a file row (the file commands; see GraphPanel.fileAction). */
  function fileAction(action, sha, f, parent) {
    vscode.postMessage({ type: 'fileAction', action, sha, parent, file: { path: f.path, origPath: f.origPath, status: f.status, group: f.group } });
  }

  /**
   * What every file row carries: its right-click menu (the file commands), its viewed mark key,
   * and — a commit's file you have not opened yet — bold.
   */
  function decorateFile(div, f, sha, parent) {
    const wt = sha === WORKTREE_SHA;
    div.dataset.vscodeContext = JSON.stringify({
      webviewSection: 'file', surface: settings.surface, sha, parent, path: f.path, origPath: f.origPath, status: f.status, group: f.group,
      wtFile: wt, deleted: f.status === 'D', unviewed: !!f.unviewed, preventDefaultContextMenuItems: true,
    });
    if (!f.vk) return;
    div.dataset.vk = f.vk;
    div.dataset.sha = sha;
    setUnviewed(div, settings.markUnviewed !== false && (vkState.has(f.vk) ? !vkState.get(f.vk) : !!f.unviewed));
  }

  /** "3/12" (or ✓ when all) after a commit's message: how many of its files you have opened. */
  function viewedBadge(sha) {
    const c = viewedCounts.get(sha);
    if (!c || settings.markUnviewed === false) return null;
    const [v, t] = c;
    const b = el('span', `viewed-count${v >= t ? ' done' : ''}`);
    if (v >= t) b.appendChild(ui.icon('check', { size: 11 }));
    else b.textContent = `${v}/${t}`;
    b.title = v >= t ? (t === 1 ? 'The file is viewed' : `All ${t} files viewed`) : `${v} of ${t} file${t === 1 ? '' : 's'} viewed`;
    return b;
  }

  /** Redraw the "3/12" of the rows on screen. */
  function refreshViewedBadges() {
    for (const [i, entry] of live) {
      const r = rows[i];
      const desc = r && entry.el.querySelector('.cell.desc');
      if (!desc) continue;
      const old = desc.querySelector('.viewed-count');
      const b = viewedBadge(r.sha);
      if (old && b) old.replaceWith(b);
      else if (old) old.remove();
      else if (b) desc.appendChild(b);
    }
  }

  /** A commit's file list arrived: its count, when you have opened any of them. */
  function countFromFiles(sha, files) {
    if (!files || settings.markUnviewed === false) return;
    const marked = files.filter((f) => f.vk);
    const v = marked.filter((f) => !(vkState.has(f.vk) ? !vkState.get(f.vk) : f.unviewed)).length;
    if (v) viewedCounts.set(sha, [v, marked.length]);
    else viewedCounts.delete(sha);
  }

  /** Bold (not opened yet) or not, with the tooltip and the context menu's data to match. */
  function setUnviewed(div, on) {
    div.classList.toggle('unviewed', on);
    const base = (div.title || '').replace(/\n?Not viewed: .*$/s, '');
    const note = 'Not viewed: bold until you open it (V toggles, N goes to the next one)';
    div.title = on ? (base ? `${base}\n${note}` : note) : base;
    try {
      const c = JSON.parse(div.dataset.vscodeContext || '{}');
      c.unviewed = on;
      div.dataset.vscodeContext = JSON.stringify(c);
    } catch { /* no context */ }
  }

  /** The buttons of a commit's file: open it as it is now, compare it with the working file. */
  function commitFileActions(sha, f, parent) {
    const acts = { el: el('span', 'file-acts float') };
    if (f.status !== 'D') acts.el.append(actButton('compare', 'Compare with the working file (W)', () => fileAction('compareWorking', sha, f, parent)));
    acts.el.append(actButton('goToFile', 'Open the working file (O), at this line if its diff is open', () => fileAction('openWorking', sha, f, parent)));
    acts.hint = `O opens the working file, W compares with it, B with ${compareBaseName || 'the base branch'}, V toggles viewed, N goes to the next unviewed file.`;
    return acts;
  }

  /**
   * Letter keys on any file row: o open the working file, w compare with it, b compare with the
   * base branch (Shift+B: pick a branch), v viewed on/off, n next unviewed file. True when taken.
   */
  function fileKey(ev, sha, f, parent, div) {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || chordKeys.has(ev) || ev.key.length !== 1) return false;
    const wt = sha === WORKTREE_SHA;
    const marks = !!f.vk && settings.markUnviewed !== false;
    const k = ev.key.toLowerCase(); // Caps Lock: Shift decides, not the letter's case
    let action;
    if (k === 'o') action = 'openWorking';
    else if (k === 'w' && !wt && f.status !== 'D') action = 'compareWorking';
    else if (k === 'b') action = ev.shiftKey ? 'compareRef' : 'compareBase';
    else if (k === 'v' && marks) action = div.classList.contains('unviewed') ? 'markViewed' : 'markUnviewed';
    else if (k === 'n' && marks) {
      ev.preventDefault();
      ev.stopPropagation();
      nextUnviewed(div);
      return true;
    }
    if (!action) return false;
    ev.preventDefault();
    ev.stopPropagation();
    fileAction(action, sha, f, parent);
    return true;
  }

  /**
   * The next file of the same commit that is still bold, after `from` (around to the start):
   * the keyboard goes there and its diff opens beside, as Space does.
   */
  function nextUnviewed(from) {
    const box = from.closest('.files-block');
    if (box && from.dataset.sha !== WORKTREE_SHA) {
      // A commit's files: in the order of its whole tree, folders closed or not.
      const i = Number(box.id.replace('files-', ''));
      const e = rows[i] && expanded.get(rows[i].sha);
      const order = e && e.files ? fileTreeLines(e.files).filter((l) => l.kind === 'file').map((l) => l.file) : [];
      const unviewed = (f) => (vkState.has(f.vk) ? !vkState.get(f.vk) : !!f.unviewed);
      const k = order.findIndex((f) => `${f.group || ''}:${f.path}` === from.dataset.fkey);
      const next = [...order.slice(k + 1), ...order.slice(0, Math.max(0, k))].find(unviewed);
      if (!next) return allViewed();
      let line = box.querySelector(`[data-fkey="${CSS.escape(`:${next.path}`)}"]`);
      if (!line && e.collapsed && e.collapsed.size) {
        // In a closed folder: open the folders, then it is there.
        e.collapsed.clear();
        e.lines = undefined;
        relayout();
        const again = liveFiles.get(i);
        line = again && again.el.querySelector(`[data-fkey="${CSS.escape(`:${next.path}`)}"]`);
      }
      if (line) return openFrom(line);
      return vscode.postMessage({ type: 'openFile', kind: 'commit', file: next, sha: rows[i].sha, parent: e.parent, keepFocus: true });
    }
    // The uncommitted files and the details pane: the list as shown.
    const scope = from.closest('.files-block, .files');
    const lines = scope ? [...scope.querySelectorAll('[data-vk]')] : [];
    const k = lines.indexOf(from);
    const next = [...lines.slice(k + 1), ...lines.slice(0, Math.max(0, k))].find((x) => x.classList.contains('unviewed'));
    if (!next) return allViewed(from.dataset.sha === WORKTREE_SHA);
    openFrom(next);
  }
  function allViewed(uncommitted) {
    vscode.postMessage({ type: 'allViewed', uncommitted: !!uncommitted });
    announcer.textContent = uncommitted ? 'All uncommitted files are viewed' : 'All files of this commit are viewed';
  }
  /** Keyboard to that line, and its diff opens beside (as Space does). */
  function openFrom(line) {
    line.focus();
    line.scrollIntoView({ block: 'nearest' });
    line.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
  }

  /** The actions of one uncommitted file, by its group. */
  function fileActions(i, f) {
    const p = { path: f.path, group: f.group };
    const acts = { el: el('span', 'file-acts') };
    if (f.group === 'staged') {
      acts.unstage = () => wtAction('unstage', p);
      acts.el.append(actButton('minus', 'Unstage (- or u)', acts.unstage));
      acts.hint = 'Minus unstages.';
    } else {
      acts.stage = () => wtAction('stage', p);
      if (f.group !== 'merge') acts.discard = () => wtAction('discard', p);
      if (acts.discard) acts.el.append(actButton(f.group === 'untracked' ? 'trash' : 'discard', f.group === 'untracked' ? 'Delete (move to the trash) (Delete or d)' : 'Discard changes (Delete or d)', acts.discard));
      acts.el.append(actButton('plus', f.group === 'merge' ? 'Mark as resolved: stage (+ or s)' : 'Stage (+ or s)', acts.stage));
      acts.hint = f.group === 'merge' ? 'Plus marks it resolved.' : `Plus stages, Delete ${f.group === 'untracked' ? 'deletes' : 'discards'}.`;
    }
    return acts;
  }

  /** The actions of a folder in a group: on every file of that group under it. */
  function folderActions(i, group, folder) {
    const p = { folder, group };
    const acts = { el: el('span', 'file-acts') };
    if (group === 'staged') {
      acts.unstage = () => wtAction('unstage', p);
      acts.el.append(actButton('minus', 'Unstage the folder (- or u)', acts.unstage));
    } else if (group === 'unstaged' || group === 'untracked') {
      acts.stage = () => wtAction('stage', p);
      acts.discard = () => wtAction('discard', p);
      acts.el.append(
        actButton(group === 'untracked' ? 'trash' : 'discard', group === 'untracked' ? 'Delete the folder\'s new files (Delete or d)' : 'Discard the folder\'s changes (Delete or d)', acts.discard),
        actButton('plus', 'Stage the folder (+ or s)', acts.stage),
      );
    }
    return acts.unstage || acts.stage ? acts : undefined;
  }

  /** The actions of a whole group (Staged, Changes, Untracked). */
  function groupActions(i, group) {
    const acts = { el: el('span', 'file-acts') };
    if (group === 'staged') {
      acts.unstage = () => wtAction('unstageAll');
      acts.el.append(actButton('minus', 'Unstage all (- or u)', acts.unstage));
    } else if (group === 'unstaged' || group === 'untracked') {
      acts.discard = () => wtAction('discardGroup', { group });
      acts.stage = () => wtAction('stageGroup', { group });
      acts.el.append(
        actButton(group === 'untracked' ? 'trash' : 'discard', group === 'untracked' ? 'Delete all untracked files (Delete or d)' : 'Discard all changes (Delete or d)', acts.discard),
        actButton('plus', 'Stage all (+ or s)', acts.stage),
      );
    }
    return acts.unstage || acts.stage ? acts : undefined;
  }

  /**
   * The commit box at the top of the uncommitted changes: a message (Enter commits, Shift+Enter
   * starts a new line), Commit, Amend, Undo Last Commit. It is one element for as long as the
   * changes are expanded, moved into each redraw: what is typed, the caret and undo survive.
   */
  function commitBox(e) {
    if (e.commitEl) {
      syncCommitBox(e);
      return e.commitEl;
    }
    const box = el('div', 'commit-box');
    const input = /** @type {HTMLTextAreaElement} */ (el('textarea', 'commit-message'));
    input.rows = 1;
    input.setAttribute('aria-label', 'Commit message. Enter commits the staged changes, Shift+Enter starts a new line, Escape goes back to the list.');
    input.value = e.draft || '';
    // Source Control's box may have a newer draft (typed there since), or this one (kept while
    // the page was away): the host says which, now and whenever the box gets the keyboard.
    const pull = () => vscode.postMessage({ type: 'draftPull', repoRoot, text: input.value });
    input.addEventListener('focus', pull);
    setTimeout(pull, 0);
    const at = () => indexBySha.get(WORKTREE_SHA);
    input.addEventListener('input', () => {
      const before = commitBoxLines(e).length;
      e.draft = input.value;
      saveDraft(e.draft);
      if (commitBoxLines(e).length !== before) {
        e.lines = undefined; // the box grows or shrinks with the message
        relayout();
      } else syncCommitBox(e);
    });
    const commit = (amend) => {
      if (e.busy || e.generating) return;
      clearTimeout(saveDraft.timer); // the message is committed, not sent on as a draft
      saveDraft.timer = undefined;
      e.busy = true; // until the host answers (wtDone): a second Enter does not commit again
      syncCommitBox(e);
      e.refocus = { commit: true };
      wtAction(amend ? 'amend' : 'commit', { message: input.value });
    };
    input.addEventListener('keydown', (ev) => {
      if (chordKeys.has(ev)) return; // Ctrl+Alt+G W: VS Code's, not a "w" in the message
      // Typing is not list navigation (the list skips keys from here); VS Code's chords still work.
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        commit(false);
      } else if (ev.key === 'Escape' && e.generating) {
        ev.preventDefault();
        vscode.postMessage({ type: 'generateStop' });
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        cursor = at();
        scroller.focus();
        cursorChanged();
      } else if (ev.key === 'ArrowDown' && !ev.shiftKey && !input.value.slice(input.selectionEnd).includes('\n')) {
        // From the last line on into the files.
        ev.preventDefault();
        focusFiles(at(), false, { skipMessage: true });
      } else if (ev.key === 'ArrowUp' && !ev.shiftKey && !input.value.slice(0, input.selectionStart).includes('\n')) {
        // From the first line back to the row.
        ev.preventDefault();
        cursor = at();
        scroller.focus();
        cursorChanged();
      }
    });
    const bar = el('div', 'commit-actions');
    const guard = (fn) => () => {
      if (!e.busy && !e.generating) fn();
    };
    const commitBtn = button('Commit', 'Commit the staged changes (Enter in the message)', guard(() => commit(false)), 'check');
    commitBtn.classList.add('primary');
    // ✨ A language model writes the message (what Commit would commit); again: stop.
    const genBtn = button('', 'Generate a commit message (language model)', () => {
      if (e.generating) {
        vscode.postMessage({ type: 'generateStop' });
        return;
      }
      if (e.busy) return;
      e.generating = true;
      e.genBefore = input.value;
      syncCommitBox(e);
      vscode.postMessage({ type: 'generateMessage', repoRoot });
    }, 'sparkle');
    genBtn.classList.add('generate');
    // Narrow (the sidebar): Amend and Undo shrink to their icons; the tooltips stay.
    bar.append(
      commitBtn,
      genBtn,
      button('Amend', 'Amend the last commit with the staged changes (and this message, if any)', guard(() => commit(true)), 'edit'),
      button('Undo Last Commit', 'Undo the last commit; its changes come back staged', guard(() => {
        e.busy = true;
        syncCommitBox(e);
        wtAction('undoCommit');
      }), 'undo'),
    );
    for (const b of bar.querySelectorAll('button')) {
      b.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Escape') return;
        ev.preventDefault();
        cursor = at();
        scroller.focus();
        cursorChanged();
      });
    }
    box.append(input, bar);
    e.commitEl = box;
    syncCommitBox(e);
    return box;
  }

  /** Size and busy state of the commit box. Busy: read-only, never disabled (it keeps the keyboard). */
  function syncCommitBox(e) {
    const box = e.commitEl;
    if (!box) return;
    const n = commitBoxLines(e).length - 1;
    box.style.height = `${(n + 1) * FILE_H}px`;
    const input = /** @type {HTMLTextAreaElement} */ (box.querySelector('.commit-message'));
    input.style.height = `${n * FILE_H - 2}px`;
    input.readOnly = !!(e.busy || e.generating);
    // As Source Control says it: where the commit goes (the branch can change while it is open).
    // Short: the sidebar is narrow (the branch must not be cut off).
    input.placeholder = head && head.branch ? `Commit to "${head.branch}" (Enter)` : 'Message (Enter to commit)';
    box.classList.toggle('busy', !!(e.busy || e.generating));
    for (const b of box.querySelectorAll('button')) b.setAttribute('aria-disabled', (e.busy || e.generating) && !b.classList.contains('generate') ? 'true' : 'false');
    // While a message is written, ✨ is Stop.
    const gen = /** @type {HTMLElement} */ (box.querySelector('button.generate'));
    if (gen && gen.dataset.state !== (e.generating ? 'stop' : 'go')) {
      gen.dataset.state = e.generating ? 'stop' : 'go';
      gen.replaceChildren(ui.icon(e.generating ? 'stop' : 'sparkle'));
      gen.title = e.generating ? 'Stop writing (Escape)' : 'Generate a commit message (language model)';
      gen.setAttribute('aria-label', gen.title);
    }
  }

  /** The generated message as it is written (`text`), then the end (`done`; `failed`: put back what was there). */
  function onGeneratedMessage(m) {
    const e = expanded.get(WORKTREE_SHA);
    // Only for the repository shown, and only while this page asked for it (a re-created page
    // never lets an old run overwrite the draft it restored).
    if (!e || !e.commitEl || m.repoRoot !== repoRoot || !e.generating) return;
    const input = /** @type {HTMLTextAreaElement} */ (e.commitEl.querySelector('.commit-message'));
    const text = m.failed ? e.genBefore || '' : typeof m.text === 'string' ? m.text : undefined;
    if (text !== undefined) {
      const before = commitBoxLines(e).length;
      input.value = text;
      e.draft = text;
      if (commitBoxLines(e).length !== before) {
        e.lines = undefined;
        relayout();
      }
    }
    if (m.done) {
      // Editable again first: a read-only box ignores the edit below.
      e.generating = false;
      syncCommitBox(e);
    }
    if (m.done && !m.failed && typeof m.text === 'string') {
      // The final text as one edit: Ctrl+Z brings back what was there before ✨. Nothing written
      // (stopped at once): what was there stays.
      const finalText = m.text || e.genBefore || '';
      const before = commitBoxLines(e).length;
      input.value = e.genBefore || '';
      input.focus({ preventScroll: true });
      input.select();
      const inserted = !!document.execCommand && document.execCommand('insertText', false, finalText) && input.value === finalText;
      if (!inserted) input.value = finalText; // no undo step then, but the text is right
      e.draft = input.value;
      if (commitBoxLines(e).length !== before) {
        e.lines = undefined;
        relayout();
      }
    }
    if (m.done) {
      saveDraft(e.draft || '');
      announcer.textContent = m.failed ? 'No commit message generated' : 'Commit message written';
    }
    syncCommitBox(e);
  }

  /** Where in commit i's files block the keyboard is (to find it again after a redraw). */
  function focusMark(i, box) {
    const a = /** @type {HTMLElement} */ (document.activeElement);
    const lines = [...box.querySelectorAll('.file-line.file, .file-line.folder')];
    const commit = a.classList.contains('commit-message');
    return {
      el: a, // the commit box (message and buttons) is moved, not re-created: the same element
      sha: rows[i] && rows[i].sha,
      commit,
      selection: commit ? [/** @type {HTMLTextAreaElement} */ (a).selectionStart, /** @type {HTMLTextAreaElement} */ (a).selectionEnd] : undefined,
      fkey: a.dataset.fkey,
      key: a.dataset.key,
      index: lines.indexOf(a),
    };
  }

  function restoreFocus(mark) {
    if (mark.el.isConnected) {
      mark.el.focus({ preventScroll: true });
      if (mark.selection) mark.el.setSelectionRange(mark.selection[0], mark.selection[1]);
      return;
    }
    const i = indexBySha.get(mark.sha);
    const box = i !== undefined && liveFiles.get(i);
    if (!box) {
      scroller.focus();
      return;
    }
    if (mark.commit) {
      const input = /** @type {HTMLTextAreaElement} */ (box.el.querySelector('.commit-message'));
      if (input) {
        input.focus({ preventScroll: true });
        input.setSelectionRange(mark.selection[0], mark.selection[1]);
        return;
      }
    }
    const lines = /** @type {HTMLElement[]} */ ([...box.el.querySelectorAll('.file-line.file, .file-line.folder')]);
    const same = lines.find((x) => (mark.fkey && x.dataset.fkey === mark.fkey) || (!mark.fkey && mark.key && x.dataset.key === mark.key));
    const target = same || lines[Math.min(Math.max(mark.index, 0), lines.length - 1)];
    if (target) target.focus();
    else {
      cursor = i;
      scroller.focus();
    }
  }

  /** Collapse or expand a folder of commit i's file tree, keeping the keyboard on it. */
  function toggleFolder(i, key) {
    const e = rows[i] && expanded.get(rows[i].sha);
    if (!e || !key) return;
    if (e.collapsed.has(key)) e.collapsed.delete(key);
    else e.collapsed.add(key);
    e.lines = undefined;
    relayout();
    const box = liveFiles.get(i);
    const again = box && [...box.el.querySelectorAll('.file-line.folder')].find((x) => x.dataset.key === key);
    if (again) again.focus();
  }

  /** Move keyboard focus from a commit into its file list. */
  function focusFiles(i, last = false, o = {}) {
    let box = liveFiles.get(i);
    if (!box) {
      // Scrolled out of the rendered window: bring the commit's files into view first.
      scroller.scrollTop = Math.max(0, rowTop(i) - ROW_H);
      render();
      box = liveFiles.get(i);
    }
    const files = box ? /** @type {HTMLElement[]} */ ([...box.el.querySelectorAll('.file-line.file, .file-line.folder')]) : [];
    // The uncommitted changes start with their commit message.
    const message = !last && !o.skipMessage && box && box.el.querySelector('.commit-message');
    const target = message || (last ? files[files.length - 1] : files[0]);
    if (target) target.focus();
    return !!target;
  }

  const hasFiles = (i) => isExpanded(i) && expansionLines(i).some((l) => l.kind === 'file' || l.kind === 'folder' || l.kind === 'commit');
  /** The row at a y offset (binary search; rows are ordered by their top). */
  function indexAt(y) {
    let lo = 0;
    let hi = Math.max(0, rows.length - 1);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (rowTop(mid) <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  /** index -> separator element, like `live` for rows. */
  const liveSeps = new Map();

  /** A time-range separator: the lanes pass through, the range's name sits on the line. */
  function renderSeparator(i, label) {
    const sep = el('div', 'time-sep');
    sep.style.top = `${rowTop(i) - SEP_H}px`;
    sep.setAttribute('aria-hidden', 'true');
    const lanes = document.createElementNS(SVG_NS, 'svg');
    lanes.setAttribute('width', String(lanesShown() * LANE_W + 6));
    lanes.setAttribute('height', String(SEP_H));
    lanes.setAttribute('class', 'graph-svg');
    for (const l of rows[i].g.lines) {
      // Lines entering row i from above continue straight through the separator.
      if (l.kind !== 'pass' && l.kind !== 'in') continue;
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', `M${x(l.from)} 0V${SEP_H}`);
      p.setAttribute('class', `lane c${l.color}`);
      lanes.appendChild(p);
    }
    sep.append(lanes, el('span', 'time-sep-label', label), el('span', 'time-sep-rule'));
    return sep;
  }

  /** The search's navigation and clear buttons only while there is a search (a narrow editor's toolbar stays on one row). */
  function updateSearchParts() {
    const active = !!(highlight || searchBox.value || searchBox.dataset.active === '1');
    for (const b of [prevBtn, nextBtn, clearBtn, matchInfo]) b.hidden = !active;
  }

  function render() {
    updateSearchParts();
    const total = rows.length + (hasMore ? 1 : 0);
    sizer.style.height = `${rowTop(rows.length) + (hasMore ? ROW_H : 0) || total * ROW_H}px`;
    const top = scroller.scrollTop;
    const first = Math.max(0, indexAt(top) - OVERSCAN);
    const last = Math.min(rows.length - 1, indexAt(top + scroller.clientHeight) + OVERSCAN);
    for (const [i, entry] of live) {
      if (i < first || i > last || entry.version !== dataVersion) {
        entry.el.remove();
        live.delete(i);
      }
    }
    for (const [i, entry] of liveSeps) {
      if (i < first || i > last || entry.version !== dataVersion) {
        entry.el.remove();
        liveSeps.delete(i);
      }
    }
    // A files block redrawn while it has the keyboard (new data after staging, …): the focus
    // comes back to the same line, or to the commit message box.
    let keep;
    for (const [i, entry] of liveFiles) {
      if (i < first || i > last || entry.version !== dataVersion) {
        if (entry.el.contains(document.activeElement)) keep = focusMark(i, entry.el);
        entry.el.remove();
        liveFiles.delete(i);
      }
    }
    for (let i = first; i <= last; i++) {
      if (!isExpanded(i) || liveFiles.has(i)) continue;
      const box = renderFiles(i);
      layer.appendChild(box);
      liveFiles.set(i, { el: box, version: dataVersion });
    }
    if (keep) restoreFocus(keep);
    for (const [i, label] of bucketStarts) {
      if (i < first || i > last || liveSeps.has(i)) continue;
      const sep = renderSeparator(i, label);
      layer.appendChild(sep);
      liveSeps.set(i, { el: sep, version: dataVersion });
    }
    // Computed at most once per render, and only when a row needs it.
    let cached;
    const selList = () => cached || (cached = selectionList());
    for (let i = first; i <= last; i++) {
      const entry = live.get(i);
      if (entry) updateRowState(entry.el, i, selList);
      else {
        const div = renderRow(i, selList);
        layer.appendChild(div);
        live.set(i, { el: div, version: dataVersion });
      }
    }
    requestStats(first, last);
    if (hasMore && last >= rows.length - 1) {
      if (!moreEl) {
        moreEl = el('div', 'row more');
        moreEl.appendChild(button('Load more commits…', 'Load the next page of history', () => vscode.postMessage({ type: 'loadMore' })));
      }
      moreEl.style.top = `${rowTop(rows.length)}px`;
      if (!moreEl.isConnected) layer.appendChild(moreEl);
    } else if (moreEl) moreEl.remove();
  }

  scroller.addEventListener('scroll', () => {
    scheduleRender();
    persist({ scrollTop: scroller.scrollTop });
  });
  /** How many branch badges an editor-graph row shows in full: 1–3, by the message column's width. */
  function badgeRoom() {
    const relative = settings.dateFormat === 'relative';
    const tight = root.classList.contains('tight');
    const others = graphWidth() + (settings.showAuthor ? (tight ? 30 : 150) : 0) + (settings.showChanges ? (root.classList.contains('xtight') ? 34 : 118) : 0) + (settings.showDate ? (relative ? 74 : 130) : 0) + (shaShown() ? 70 : 0);
    const desc = Math.max(160, window.innerWidth - others);
    // Badges take at most about 60% of it (the message keeps the rest), some 90 px each.
    return Math.max(1, Math.min(3, Math.floor((desc * 0.6) / 90)));
  }
  let lastBadgeRoom = 0;

  window.addEventListener('resize', () => {
    // Crossing the narrow width changes the columns; another number of badges, the rows.
    const narrow = !!settings.compact && window.innerWidth < 360;
    const tight = !settings.compact && window.innerWidth < 700;
    const xtight = tight && window.innerWidth < 520;
    if (narrow !== root.classList.contains('narrow') || tight !== root.classList.contains('tight') || xtight !== root.classList.contains('xtight')) {
      applyColumns();
      dataVersion++;
    }
    if (!settings.compact && badgeRoom() !== lastBadgeRoom) {
      lastBadgeRoom = badgeRoom();
      dataVersion++;
    }
    scheduleRender();
  });

  // ---------------------------------------------------------------- selection

  function selectIndex(i, { toggle = false, range = false, reveal = true } = {}) {
    if (i < 0 || i >= rows.length) return;
    const sha = rows[i].sha;
    if (range && anchor >= 0) {
      selected = new Set();
      const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
      for (let k = a; k <= b; k++) selected.add(rows[k].sha);
    } else if (toggle) {
      if (selected.has(sha)) selected.delete(sha);
      else selected.add(sha);
      anchor = i;
    } else {
      selected = new Set([sha]);
      anchor = i;
    }
    // The working-tree row cannot be combined with commits.
    if (selected.size > 1) selected.delete(WORKTREE_SHA);
    cursor = i;
    if (reveal) ensureVisible(i);
    scheduleRender();
    notifySelection();
    cursorChanged();
  }

  /**
   * The keyboard cursor drives the native context menu (Shift+F10 / Menu key
   * open the same menu as a right-click on the row), the active descendant
   * for screen readers, and a short spoken summary.
   */
  function cursorChanged() {
    if (cursor < 0 || !rows[cursor]) {
      scroller.removeAttribute('aria-activedescendant');
      delete scroller.dataset.vscodeContext;
      return;
    }
    const r = rows[cursor];
    scroller.setAttribute('aria-activedescendant', `row-${cursor}`);
    if (r.sha === WORKTREE_SHA) delete scroller.dataset.vscodeContext;
    else scroller.dataset.vscodeContext = commitContext(r, selectionList);
    // The option's own label is what screen readers read on a move (aria-activedescendant);
    // the live region only reports the size of a multi-selection.
    announcer.textContent = selected.size > 1 ? `${selected.size} selected` : '';
  }

  // Keyboard focus arriving with no cursor yet: the cursor starts on the first row (without
  // selecting it), so screen readers announce a row and the first ↓ goes to the second.
  scroller.addEventListener('focus', () => {
    if (cursor < 0 && rows.length) {
      cursor = 0;
      anchor = 0;
      scheduleRender();
      cursorChanged();
    }
  });

  /** Move the keyboard cursor without changing the selection (Ctrl+arrows). */
  function moveCursor(i) {
    if (i < 0 || i >= rows.length) return;
    cursor = i;
    ensureVisible(i);
    scheduleRender();
    cursorChanged();
  }

  function toggleAtCursor() {
    if (cursor < 0) return;
    const sha = rows[cursor].sha;
    if (sha === WORKTREE_SHA) return;
    if (selected.has(sha)) selected.delete(sha);
    else selected.add(sha);
    selected.delete(WORKTREE_SHA);
    anchor = cursor;
    scheduleRender();
    notifySelection();
    cursorChanged();
  }

  let selectTimer;
  /** Id of the latest details request: responses to older selections are ignored. */
  let detailsRequest = 0;
  function notifySelection() {
    clearTimeout(selectTimer);
    selectTimer = setTimeout(() => {
      const ordered = rows.filter((r) => selected.has(r.sha)).map((r) => r.sha);
      persist({ selection: ordered });
      vscode.postMessage({ type: 'select', shas: ordered, requestId: ++detailsRequest });
      if (!ordered.length) showPlaceholder();
    }, 120);
  }

  function ensureVisible(i) {
    const top = rowTop(i);
    if (top - (bucketStarts.has(i) ? SEP_H : 0) < scroller.scrollTop) scroller.scrollTop = top - (bucketStarts.has(i) ? SEP_H : 0);
    else if (top + ROW_H > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + ROW_H - scroller.clientHeight;
  }

  function revealSha(sha, select) {
    if (!sha) return;
    const i = indexBySha.get(sha);
    if (i === undefined) return;
    scroller.scrollTop = Math.max(0, rowTop(i) - scroller.clientHeight / 3);
    if (select) selectIndex(i, { reveal: false });
    scheduleRender();
  }

  function rowIndexFromEvent(e) {
    const t = /** @type {HTMLElement} */ (e.target).closest('.row');
    if (!t || !t.dataset.index) return -1;
    return Number(t.dataset.index);
  }

  layer.addEventListener('mousedown', (e) => {
    if (e.button !== 0 && e.button !== 2) return;
    const i = rowIndexFromEvent(e);
    if (i < 0) return;
    scroller.focus();
    if (e.button === 2) {
      // Right-click on an unselected row selects it, like a file explorer.
      if (!selected.has(rows[i].sha)) selectIndex(i, { reveal: false });
      return;
    }
    selectIndex(i, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey, reveal: false });
  });

  layer.addEventListener('dblclick', (e) => {
    const i = rowIndexFromEvent(e);
    if (i >= 0) vscode.postMessage({ type: 'openCommit', sha: rows[i].sha });
  });

  scroller.addEventListener('keydown', (e) => {
    if (chordKeys.has(e)) return;
    // From a file line or the commit box: their own handlers took what they use; the rest is
    // not list navigation (Ctrl/Cmd chords, copy and search, still are).
    const t = /** @type {HTMLElement} */ (e.target);
    // Typing in the commit message: every key is the box's (Ctrl+C copies its text, Ctrl+A
    // selects it, Ctrl+Home goes to its start); only search (Ctrl+F, on the document) is global.
    if (t.matches && t.matches('textarea, input')) return;
    if (t !== scroller && t.closest && t.closest('.files-block') && !e.ctrlKey && !e.metaKey && e.key !== '?') return;
    const page = Math.max(1, Math.floor(scroller.clientHeight / ROW_H) - 1);
    const move = (to) => {
      e.preventDefault();
      selectIndex(Math.max(0, Math.min(rows.length - 1, to)), { range: e.shiftKey });
    };
    // Keyboard access to the commit actions that the mouse reaches through the context menu.
    // Shift+F10 / the Menu key open VS Code's native menu for the cursor row (scroller carries its
    // context); "." opens the same actions as a searchable quick pick.
    if (e.key === '.') {
      e.preventDefault();
      if (cursor >= 0) {
        // Same rule as the context menu: the selection when the cursor is in it, else the cursor's commit.
        const sha = rows[cursor].sha;
        vscode.postMessage({ type: 'actions', sha, shas: selected.has(sha) ? selectionList() : [sha], refs: rows[cursor].refs });
      }
      return;
    }
    if (e.key === 'Escape' && (highlight || searchBox.dataset.active === '1')) {
      e.preventDefault();
      clearSearch();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      moveCursor(cursor + (e.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === ' ') {
      e.preventDefault();
      toggleAtCursor();
      return;
    }
    // Moving past the last loaded commit loads the next page.
    if (hasMore && ((e.key === 'ArrowDown' && cursor >= rows.length - 1) || e.key === 'End' || (e.key === 'PageDown' && cursor + 10 >= rows.length - 1))) {
      vscode.postMessage({ type: 'loadMore' });
    }
    if (e.key === '?') {
      e.preventDefault();
      toggleHelp();
      return;
    }
    // → shows the cursor commit's files (again: into them), ← hides them; Tab enters them.
    if (cursor >= 0 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey && isExpanded(cursor))) {
        e.preventDefault();
        if (!isExpanded(cursor)) toggleExpanded(cursor, true);
        else focusFiles(cursor);
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        toggleExpanded(cursor, false);
        return;
      }
      // Like a tree: ↓ from an open commit goes into its files, ↑ into the open commit above.
      if (e.key === 'ArrowDown' && !e.shiftKey && hasFiles(cursor)) {
        e.preventDefault();
        focusFiles(cursor);
        return;
      }
      if (e.key === 'ArrowUp' && !e.shiftKey && cursor > 0 && hasFiles(cursor - 1)) {
        e.preventDefault();
        const above = cursor - 1;
        selectIndex(above);
        focusFiles(above, true);
        return;
      }
    }
    if (e.key === 'Tab' && !e.shiftKey && !settings.compact && detailsPane.querySelector('button, .file')) {
      // Tab from the list goes straight to the details pane.
      e.preventDefault();
      detailsPane.querySelector('button, .file').focus();
      return;
    }
    switch (e.key) {
      case 'ArrowDown': move(cursor + 1); break;
      case 'ArrowUp': move(cursor - 1); break;
      case 'PageDown': move(cursor + page); break;
      case 'PageUp': move(cursor - page); break;
      case 'Home': move(0); break;
      case 'End': move(rows.length - 1); break;
      case 'Enter':
        e.preventDefault();
        // Same rule as "." and the context menu: the selection when the cursor is in it.
        if (cursor >= 0 && selected.size > 1 && selected.has(rows[cursor].sha)) vscode.postMessage({ type: 'openCommits', shas: selectionList() });
        else if (cursor >= 0) vscode.postMessage({ type: 'openCommit', sha: rows[cursor].sha });
        break;
      case 'c':
        if ((e.ctrlKey || e.metaKey) && copyText()) {
          e.preventDefault();
          vscode.postMessage({ type: 'copy', text: copyText() });
        }
        break;
      case 'a':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          selected = new Set(rows.filter((r) => r.sha !== WORKTREE_SHA).map((r) => r.sha));
          scheduleRender();
          notifySelection();
          cursorChanged();
        }
        break;
      case ' ':
        // Space selects the cursor's commit alone (after Ctrl+arrows); it never scrolls the list.
        // In the sidebar it also previews the commit's changes while focus stays in the list.
        e.preventDefault();
        if (cursor >= 0) {
          selectIndex(cursor);
          if (settings.compact && rows[cursor].sha !== WORKTREE_SHA) vscode.postMessage({ type: 'openCommit', sha: rows[cursor].sha, preview: true });
        }
        break;
      default:
        break;
    }
  });

  // Shift+F10 / the Menu key fire "contextmenu" on the focused list itself, which would place
  // VS Code's menu in the middle of the list. Re-dispatch it from the cursor row instead (VS Code
  // reads the position and data-vscode-context of the event it sees).
  scroller.addEventListener('contextmenu', (e) => {
    if (e.target !== scroller || cursor < 0 || !rows[cursor]) return;
    ensureVisible(cursor);
    render();
    const entry = live.get(cursor);
    if (!entry) return;
    e.preventDefault();
    e.stopPropagation();
    const box = entry.el.getBoundingClientRect();
    const subject = entry.el.querySelector('.subject');
    const left = subject ? subject.getBoundingClientRect().left : box.left + 24;
    entry.el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: Math.round(left), clientY: Math.round(box.top + box.height / 2) }));
  });

  /** What Ctrl+C copies in the list: the selected SHAs, else the cursor's. */
  function copyText() {
    const shas = rows.filter((r) => selected.has(r.sha) && r.sha !== WORKTREE_SHA).map((r) => r.sha);
    if (shas.length) return shas.join('\n');
    return cursor >= 0 && rows[cursor] && rows[cursor].sha !== WORKTREE_SHA ? rows[cursor].sha : '';
  }

  // VS Code runs its own Copy in the webview for Ctrl+C: fill the clipboard with the SHAs, so
  // that copy (whichever arrives last) never carries page text.
  document.addEventListener('copy', (e) => {
    if (!scroller.contains(document.activeElement) && document.activeElement !== scroller) return;
    if (document.activeElement.matches('textarea, input')) return; // the commit message's own text
    const text = copyText();
    if (!text || !e.clipboardData) return;
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
  });

  // When VS Code focuses the view or tab (Ctrl+Alt+G V / G), the keyboard lands in the list.
  window.addEventListener('focus', () => {
    if (document.activeElement === document.body) scroller.focus();
  });

  document.addEventListener('keydown', (e) => {
    // Safety net: with focus on <body> (after VS Code focused the view or tab, or an element
    // disappeared) every list key goes to the list.
    if (document.activeElement === document.body && !['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key)) {
      scroller.focus();
      scroller.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, bubbles: true, cancelable: true }));
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      showSearch();
    }
  });

  /**
   * "11 files: 2 new, 9 changed · +470 −39" as DOM. Files are counted in words, lines in +/−
   * (the notation of the change bars), so the two never look alike.
   */
  function summaryLine(summary, st) {
    const line = el('span', 'summary');
    if (summary) {
      const kinds = [[summary.added, 'new', 'add'], [summary.modified + summary.renamed, 'changed', 'mod'], [summary.deleted, 'deleted', 'del']].filter(([n]) => n);
      line.append(el('span', 'dim', `${summary.files} file${summary.files === 1 ? '' : 's'}: `));
      kinds.forEach(([n, word, cls], k) => line.append(...(k ? [', '] : []), el('span', cls, `${n} ${word}`)));
      line.append(el('span', 'dim', ' · '), el('span', 'add', `+${summary.additions}`), ' ', el('span', 'del', `−${summary.deletions}`));
    } else if (st) {
      line.append(el('span', 'dim', `${st[0]} file${st[0] === 1 ? '' : 's'} changed `), el('span', 'add', `+${st[1]}`), ' ', el('span', 'del', `−${st[2]}`));
    }
    return line;
  }

  // ---------------------------------------------------------------- search & filter

  function computeMatches() {
    matches = [];
    matchSet = new Set();
    const q = highlight.toLowerCase();
    if (!q) return;
    rows.forEach((r, i) => {
      if (r.sha === WORKTREE_SHA) return;
      if (r.subject.toLowerCase().includes(q) || (r.author || '').toLowerCase().includes(q) || r.sha.startsWith(q) || (r.email || '').toLowerCase().includes(q) || r.refs.some((x) => x.name.toLowerCase().includes(q))) matches.push(i);
    });
    matchSet = new Set(matches);
  }

  function updateMatchInfo() {
    if (!highlight) {
      matchInfo.textContent = '';
      return;
    }
    if (!matches.length) matchInfo.textContent = 'no matches';
    else matchInfo.textContent = matchPos < 0 ? `${matches.length} match${matches.length === 1 ? '' : 'es'}` : `${matchPos + 1}/${matches.length}`;
  }

  function jumpMatch(dir) {
    if (!matches.length) return;
    matchPos = (matchPos + dir + matches.length) % matches.length;
    const i = matches[matchPos];
    selectIndex(i, { reveal: false });
    scroller.scrollTop = Math.max(0, rowTop(i) - scroller.clientHeight / 3);
    updateMatchInfo();
  }

  let searchTimer;
  searchBox.addEventListener('input', () => {
    if (modeSelect.value !== 'highlight') return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      highlight = searchBox.value.trim();
      computeMatches();
      matchPos = -1;
      updateMatchInfo();
      scheduleRender();
    }, 120);
  });

  /** The sidebar keeps its search row hidden until asked for (Ctrl+F or the view's Search action). */
  function showSearch() {
    toolbar.classList.add('searching');
    searchBox.focus();
    searchBox.select();
  }

  searchBox.addEventListener('keydown', (e) => {
    // Escape / ↓ go to the results; a further Escape in the list clears the search.
    if (e.key === 'Escape' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (settings.compact && e.key === 'Escape' && !searchBox.value) toolbar.classList.remove('searching');
      if (cursor < 0 && rows.length) selectIndex(matches.length ? matches[0] : 0);
      scroller.focus();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (modeSelect.value === 'highlight') {
      // Enter right after typing: use what is typed now, not what the debounce saw.
      clearTimeout(searchTimer);
      if (highlight !== searchBox.value.trim()) {
        highlight = searchBox.value.trim();
        computeMatches();
        matchPos = -1;
        scheduleRender();
      }
      jumpMatch(e.shiftKey ? -1 : 1);
    }
    else vscode.postMessage({ type: 'search', mode: modeSelect.value, text: searchBox.value.trim() });
  });

  modeSelect.addEventListener('change', () => {
    persist({ mode: modeSelect.value });
    highlight = '';
    matches = [];
    matchSet = new Set();
    updateMatchInfo();
    if (modeSelect.value === 'highlight') {
      highlight = searchBox.value.trim();
      computeMatches();
      updateMatchInfo();
    }
    scheduleRender();
  });

  function clearSearch() {
    const wasServer = searchBox.dataset.active === '1';
    if (settings.compact) toolbar.classList.remove('searching');
    searchBox.value = '';
    highlight = '';
    matches = [];
    matchSet = new Set();
    updateMatchInfo();
    scheduleRender();
    if (wasServer) vscode.postMessage({ type: 'search', text: '' });
  }

  // Debounced: arrowing through a closed <select> fires "change" for every option.
  let filterTimer;
  filterSelect.addEventListener('change', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(applyFilter, 500);
  });
  function applyFilter() {
    const v = filterSelect.value;
    let filter;
    if (v === '\0all') filter = { kind: 'all' };
    else if (v === '\0local') filter = { kind: 'local' };
    else if (v === '\0current') filter = { kind: 'current' };
    else if (v === '\0firstParent') filter = { kind: 'firstParent' };
    else filter = { kind: 'ref', ref: v };
    vscode.postMessage({ type: 'filter', filter });
  }

  function fillFilter(branches, filter) {
    const opts = [['\0all', 'All branches'], ['\0local', 'Local branches'], ['\0current', 'Current branch'], ['\0firstParent', 'Current branch, first parent only']];
    filterSelect.replaceChildren();
    for (const [v, l] of opts) {
      const o = el('option', '', l);
      o.setAttribute('value', v);
      filterSelect.appendChild(o);
    }
    const group = el('optgroup');
    group.setAttribute('label', 'Branch');
    for (const b of branches) {
      const o = el('option', '', b);
      o.setAttribute('value', b);
      group.appendChild(o);
    }
    filterSelect.appendChild(group);
    filterSelect.value = filter.kind === 'ref' ? filter.ref : `\0${filter.kind}`;
  }

  // ---------------------------------------------------------------- details pane

  function showPlaceholder() {
    const hadFocus = detailsPane.contains(document.activeElement);
    detailsPane.replaceChildren(el('div', 'placeholder', 'Select a commit to see its details: arrows, or click. Shift+arrows / Shift+click select a range; Ctrl+arrows and Ctrl+Space (or Ctrl/Cmd+click) pick separate commits.'));
    if (hadFocus) scroller.focus();
  }

  function action(label, title, command, args, iconName) {
    return button(label, title, () => vscode.postMessage({ type: 'command', command, args }), iconName);
  }

  function fileList(files, kind, extra) {
    const list = el('div', 'files');
    const title = el('div', 'files-title');
    title.append(ui.icon('files'), el('span', '', `${files.length} file${files.length === 1 ? '' : 's'} changed`));
    const add = files.reduce((n, f) => n + (f.added || 0), 0);
    const del = files.reduce((n, f) => n + (f.deleted || 0), 0);
    if (add || del) {
      const s = el('span', 'stats');
      s.append(el('span', 'add', ` +${add}`), el('span', 'del', ` −${del}`));
      title.appendChild(s);
    }
    list.appendChild(title);
    for (const f of files) {
      const item = el('div', 'file');
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.setAttribute('aria-label', `${f.status} ${f.path}`);
      if (kind !== 'multi') item.title = `${f.path}${f.added !== undefined && f.added !== null ? ` — +${f.added} −${f.deleted || 0}` : ''}\n${fileKeysHint(kind === 'worktree')}`;
      const status = el('span', `status s-${f.status === '!' ? 'conflict' : f.status[0]}`, f.status === '!' ? '!' : f.status[0]);
      status.title = ({ A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Untracked', '!': 'Conflict' })[f.status === '!' ? '!' : f.status[0]] || f.status;
      const name = f.path.split('/').pop();
      const dir = f.path.slice(0, f.path.length - name.length);
      const p = el('span', 'path');
      p.append(el('span', 'name', name), el('span', 'dir', f.origPath && f.origPath !== f.path ? ` ${dir} ← ${f.origPath}` : ` ${dir}`));
      item.append(status, p);
      if (f.added !== undefined && f.added !== null) {
        const s = el('span', 'stats');
        s.append(ui.statBar(f.added, f.deleted || 0, 30), el('span', 'add', `+${f.added}`), el('span', 'del', ` −${f.deleted}`));
        item.appendChild(s);
      } else if (f.binary) item.appendChild(el('span', 'stats', 'binary'));
      if (f.group) item.appendChild(el('span', 'group', f.group));
      if (f.commits && f.commits.length > 1) item.appendChild(el('span', 'group', `${f.commits.length} commits`));
      // Space keeps the keyboard in the list (N steps through the files), Enter and a click go there.
      const open = (keep) => vscode.postMessage({ type: 'openFile', kind, file: f, ...extra, keepFocus: keep === true });
      item.addEventListener('click', () => open());
      const fsha = kind === 'commit' ? extra.sha : kind === 'worktree' ? WORKTREE_SHA : undefined;
      if (fsha) decorateFile(item, f, fsha, extra.parent);
      if (kind === 'commit') item.appendChild(commitFileActions(fsha, f, extra.parent).el);
      else if (kind === 'worktree') {
        const acts = el('span', 'file-acts float');
        acts.appendChild(actButton('goToFile', 'Open the working file (O)', () => fileAction('openWorking', fsha, f)));
        item.appendChild(acts);
      }
      item.addEventListener('keydown', (e) => {
        if (fsha && fileKey(e, fsha, f, extra.parent, item)) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open(e.key === ' ');
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const sib = e.key === 'ArrowDown' ? item.nextElementSibling : item.previousElementSibling;
          if (sib && sib.classList.contains('file')) sib.focus();
        }
      });
      list.appendChild(item);
    }
    return list;
  }

  function metaRow(label, value) {
    const row = el('div', 'meta-row');
    row.append(el('span', 'meta-label', label));
    if (typeof value === 'string') row.append(el('span', 'meta-value', value));
    else row.append(value);
    return row;
  }

  /** A SHA button: selects that commit, or with keepSelection only moves the cursor to it. */
  function shaLink(sha, keepSelection) {
    const a = el('button', 'sha-link', short(sha));
    a.type = 'button';
    a.title = keepSelection ? `${sha} — go to this commit (the selection is kept)` : `${sha} — select this commit`;
    a.setAttribute('aria-label', `${keepSelection ? 'Go to' : 'Select'} commit ${short(sha)}`);
    a.addEventListener('click', () => {
      const i = indexBySha.get(sha);
      if (keepSelection && i !== undefined) {
        scroller.scrollTop = Math.max(0, rowTop(i) - scroller.clientHeight / 3);
        moveCursor(i);
      } else revealSha(sha, true);
      scroller.focus();
    });
    return a;
  }

  /** Index of the focused control in the details pane, to restore focus after re-rendering it. */
  function detailsFocusIndex() {
    if (!detailsPane.contains(document.activeElement)) return -1;
    return [...detailsPane.querySelectorAll('button, .file')].indexOf(document.activeElement);
  }

  function restoreDetailsFocus(index) {
    if (index < 0) return;
    const items = [...detailsPane.querySelectorAll('button, .file')];
    (items[Math.min(index, items.length - 1)] || scroller).focus();
  }

  function renderDetails(m) {
    const focusIndex = detailsFocusIndex();
    const pane = el('div', 'details-inner');
    if (m.kind === 'none') {
      showPlaceholder();
      return;
    }
    if (m.kind === 'error') {
      pane.appendChild(el('div', 'error', m.message));
    } else if (m.kind === 'worktree') {
      const h = el('h2', 'with-icon');
      h.append(ui.icon('edit', { size: 16 }), el('span', '', 'Working changes'));
      pane.appendChild(h);
      const counts = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
      for (const f of m.files) counts[{ merge: 'conflicts', staged: 'staged', unstaged: 'unstaged', untracked: 'untracked' }[f.group]]++;
      const chipLine = el('div', 'card-line');
      chipLine.append(...worktreeChips(counts));
      pane.appendChild(chipLine);
      const bar = el('div', 'actions');
      bar.append(
        action('Commit…', 'Open Source Control', 'workbench.view.scm', {}, 'check'),
        action('Stash…', 'Stash these changes', 'commitCorner.stash', {}, 'stash'),
      );
      pane.appendChild(bar);
      pane.appendChild(fileList(m.files, 'worktree', {}));
    } else if (m.kind === 'commit') {
      const c = m.commit;
      const headBox = el('div', 'details-head');
      const who = el('div', 'details-who');
      who.appendChild(el('h2', '', c.subject));
      const line = el('div', 'card-line');
      const youMark = m.me && c.authorEmail && m.me.toLowerCase() === c.authorEmail.toLowerCase() ? ' (you)' : '';
      const author = el('span', 'strong', `${c.authorName}${youMark}`);
      author.title = c.authorEmail;
      const when = el('span', '', `${ui.longAge(c.authorDate)} (${ui.fullDate(c.authorDate)})`);
      line.append(author, ui.icon('clock'), when);
      who.appendChild(line);
      headBox.append(ui.avatar(c.authorName, c.authorEmail, 34), who);
      pane.appendChild(headBox);
      const what = el('div', 'card-line');
      const copy = button('', 'Copy the full SHA', () => vscode.postMessage({ type: 'copy', text: c.sha }), 'copy');
      what.append(ui.icon('commit'), el('code', 'sha-chip', c.sha.slice(0, 10)), copy, summaryLine(m.summary));
      pane.appendChild(what);
      const meta = el('div', 'meta');
      if (c.parents.length) {
        const ps = el('span', 'meta-value');
        c.parents.forEach((p, i) => {
          if (i) ps.append(' ');
          ps.append(shaLink(p));
        });
        meta.appendChild(metaRow(c.parents.length > 1 ? 'Parents' : 'Parent', ps));
      }
      if (c.committerName !== c.authorName || Math.abs(c.commitDate - c.authorDate) > 60000) {
        meta.appendChild(metaRow('Committer', `${c.committerName} <${c.committerEmail}> — ${ui.longAge(c.commitDate)} (${ui.fullDate(c.commitDate)})`));
      }
      const sig = m.signature;
      if (sig && sig.status !== 'N') {
        const labels = { G: 'Good signature', U: 'Good signature (untrusted key)', X: 'Good signature (expired)', Y: 'Good signature (expired key)', R: 'Signed with a revoked key', B: 'BAD signature', E: 'Signature cannot be checked (missing key)' };
        const v = el('span', `meta-value sig sig-${sig.status}`, `${labels[sig.status] || sig.status}${sig.signer ? ` — ${sig.signer}` : ''}${sig.key ? ` (${sig.key})` : ''}`);
        meta.appendChild(metaRow('Signature', v));
      }
      const fakeRow = { sha: c.sha, refs: (c.refs || []).map((r) => ({ ...r, rev: r.rev || r.name })) };
      const refs = groupRefs(fakeRow);
      if (refs.length) {
        const rs = el('span', 'meta-value');
        for (const { ref, remotes } of refs) rs.appendChild(refBadge(fakeRow, ref, remotes));
        meta.appendChild(metaRow('Refs', rs));
      }
      pane.appendChild(meta);
      const body = (c.body || '').split('\n').slice(1).join('\n').trim();
      if (body) pane.appendChild(el('pre', 'body', body));
      const bar = el('div', 'actions');
      bar.append(
        button('Open All Changes', 'Open every changed file in the multi-diff editor', () => vscode.postMessage({ type: 'openCommit', sha: c.sha }), 'diff'),
        action('Checkout', 'Check out this commit (detached HEAD)', 'commitCorner.checkoutDetached', { sha: c.sha }, 'check'),
        action('Branch…', 'Create a branch here', 'commitCorner.createBranch', { sha: c.sha }, 'branch'),
        action('Cherry-pick', 'Apply this commit onto the current branch', 'commitCorner.cherryPick', { sha: c.sha }, 'commit'),
        action('Revert', 'Create a commit that undoes this one', 'commitCorner.revert', { sha: c.sha }, 'refresh'),
      );
      if (onGitHub) bar.appendChild(action('GitHub', 'Open this commit on github.com', 'commitCorner.openCommitOnGitHub', { sha: c.sha }, 'open'));
      // The pull request it came with ("… (#123)", "Merge pull request #123").
      const pr = /\(#(\d+)\)\s*$/.exec(c.subject) || /^Merge pull request #(\d+)\b/.exec(c.subject);
      if (pr && onGitHub) bar.appendChild(action(`PR #${pr[1]}`, `Open pull request #${pr[1]} on github.com`, 'commitCorner.openPullRequestOnGitHub', { number: Number(pr[1]) }, 'pr'));
      pane.appendChild(bar);
      if (c.parents.length > 1) pane.appendChild(el('div', 'note', 'Merge commit: changes are shown against the first parent.'));
      pane.appendChild(fileList(m.files, 'commit', { sha: c.sha, parent: m.parent }));
    } else if (m.kind === 'multi') {
      const h = el('h2', 'with-icon');
      h.append(ui.icon('commit', { size: 16 }), el('span', '', `${m.shas.length} commits selected`));
      pane.appendChild(h);
      const sumLine = el('div', 'card-line');
      // An approximate combination has no line counts: say so instead of "0 additions".
      if (m.exact) sumLine.append(summaryLine(m.summary));
      else sumLine.append(el('span', 'dim', `${m.files.length} file${m.files.length === 1 ? '' : 's'} changed · line counts unavailable (approximate combination)`));
      pane.appendChild(sumLine);
      const list = el('div', 'commit-list');
      for (const c of m.commits.slice().reverse()) {
        const row = el('div', 'commit-item');
        const age = el('span', 'dim', ` ${ui.shortAge(c.authorDate)}`);
        age.title = ui.fullDate(c.authorDate);
        row.append(ui.avatar(c.authorName, c.authorEmail, 16), shaLink(c.sha, true), el('span', 'subject', ` ${c.subject}`), el('span', 'dim', ` — ${c.authorName}`), age);
        list.appendChild(row);
      }
      pane.appendChild(list);
      const bar = el('div', 'actions');
      bar.append(
        button('Open Combined Diff', m.exact ? 'Exactly the changes of the selected commits (unselected commits in between are left out)' : 'Approximate: each file from before the oldest selected commit that touched it to after the newest one', () => vscode.postMessage({ type: 'openCommits', shas: m.shas }), 'diff'),
        button('Open Range Diff', 'Everything between the oldest selected commit\'s parent and the newest selected commit', () => vscode.postMessage({ type: 'openRange', shas: m.shas }), 'files'),
        action(`Cherry-pick ${m.shas.length}`, 'Apply these commits (oldest first) onto the current branch', 'commitCorner.cherryPick', { shas: m.shas }, 'commit'),
        action(`Revert ${m.shas.length}`, 'Create commits that undo these', 'commitCorner.revert', { shas: m.shas }, 'refresh'),
      );
      pane.appendChild(bar);
      pane.appendChild(el('div', 'note', m.exact
        ? 'Combined diff: exactly the changes of the selected commits (replayed onto the parent of the oldest one); unselected commits in between are left out.'
        : `${(m.failed || []).map(short).join(', ')} only applies together with unselected commits: ${m.approximate && m.approximate.length ? `${m.approximate.length} file${m.approximate.length === 1 ? '' : 's'} (marked ≈) span` : 'each file spans'} from before the oldest to after the newest selected commit, including unselected edits in between${m.approximate && m.approximate.length ? '; all other files are exact' : ''}.`));
      pane.appendChild(fileList(m.files, 'multi', { shas: m.shas }));
    }
    detailsPane.replaceChildren(pane);
    restoreDetailsFocus(focusIndex);
  }

  // Esc anywhere in the details pane goes back to the commit list.
  detailsPane.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    scroller.focus();
  });

  // Resizable details pane, also from the keyboard (↑/↓ on the focused splitter).
  splitter.tabIndex = 0;
  splitter.setAttribute('role', 'separator');
  splitter.setAttribute('aria-orientation', 'horizontal');
  splitter.setAttribute('aria-label', 'Resize the details pane (up and down arrows)');
  splitter.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const h = detailsPane.getBoundingClientRect().height + (e.key === 'ArrowUp' ? 24 : -24);
    detailsPane.style.height = `${Math.max(80, Math.min(window.innerHeight - 120, h))}px`;
    persist({ detailsHeight: detailsPane.getBoundingClientRect().height });
    scheduleRender();
  });
  splitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = detailsPane.getBoundingClientRect().height;
    const move = (ev) => {
      const h = Math.max(80, Math.min(window.innerHeight - 120, startH - (ev.clientY - startY)));
      detailsPane.style.height = `${h}px`;
      scheduleRender();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      persist({ detailsHeight: detailsPane.getBoundingClientRect().height });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  // ---------------------------------------------------------------- messages

  window.addEventListener('message', (event) => {
    const m = event.data;
    switch (m.type) {
      case 'loading':
        overlay.classList.add('visible');
        break;
      case 'noRepository': {
        // A folder without git: what can be done, nothing that looks broken.
        settings = { ...settings, ...m.settings };
        applyColumns();
        overlay.classList.remove('visible');
        document.body.classList.add('no-repo');
        rows = [];
        indexBySha = new Map();
        dataVersion++;
        live.clear();
        sizer.style.height = '';
        const box = el('div', 'no-repo-box');
        box.append(el('p', '', 'No git repository in this folder.'));
        for (const [id, label, icon] of [['commitCorner.init', 'Initialize Repository', 'plus'], ['commitCorner.clone', 'Clone Repository…', 'down'], ['commitCorner.openRepository', 'Open Repository…', 'folder']]) {
          const b = button(label, label, () => vscode.postMessage({ type: 'noRepoAction', id }), icon);
          if (id === 'commitCorner.init') b.classList.add('primary');
          box.append(b);
        }
        layer.replaceChildren(box);
        announcer.textContent = 'No git repository in this folder.';
        break;
      }
      case 'error':
        overlay.classList.remove('visible');
        // No rows behind the message: keys must not draw stale rows over it.
        rows = [];
        indexBySha = new Map();
        dataVersion++;
        hasMore = false;
        cursor = -1;
        anchor = -1;
        cursorChanged();
        live.clear();
        sizer.style.height = '';
        layer.replaceChildren(el('div', 'error', `Could not load history: ${m.message}`));
        announcer.textContent = `Could not load history: ${m.message}`;
        break;
      case 'data': {
        overlay.classList.remove('visible');
        document.body.classList.remove('no-repo');
        // How many times the history was loaded (the UI tests wait for a reload by it).
        document.body.dataset.loads = String(Number(document.body.dataset.loads || 0) + 1);
        const prevTop = scroller.scrollTop;
        const prevCursor = cursor;
        const prevCursorSha = cursor >= 0 && rows[cursor] ? rows[cursor].sha : undefined;
        // Commits that were not there before (an agent's, a fetch): briefly highlighted — only on a
        // refresh of the same view (not a new filter, search or a longer history), and only commits
        // newer than everything shown before.
        const view = JSON.stringify([m.filter, m.search]);
        const sameView = !firstLoad && view === lastView;
        lastView = view;
        const before = sameView ? new Set(rows.map((r) => r.sha)) : undefined;
        // (a loop: spreading a long list into Math.max overflows the stack)
        const newest = before ? rows.reduce((n, r) => (r.sha !== WORKTREE_SHA ? Math.max(n, rowDate(r)) : n), 0) : 0;
        rows = m.rows;
        const otherRepo = repoRoot !== undefined && m.repoRoot !== repoRoot;
        if (before && !otherRepo) markArrived(rows.filter((r) => r.sha !== WORKTREE_SHA && !before.has(r.sha) && rowDate(r) >= newest).map((r) => r.sha));
        repoRoot = m.repoRoot;
        // Expanded commits stay expanded across reloads while they are still listed (the
        // uncommitted changes with their message, open groups and keyboard); the working tree's
        // files change, so they are asked for again. Another repository starts afresh.
        {
          const present = new Set(rows.map((r) => r.sha));
          if (firstLoad && Array.isArray(saved.expanded)) {
            for (const sha of saved.expanded) {
              if (typeof sha === 'string' && present.has(sha) && !expanded.has(sha)) {
                expanded.set(sha, newEntry(sha));
                vscode.postMessage({ type: 'files', sha });
              }
            }
          }
          for (const sha of [...expanded.keys()]) {
            if (!present.has(sha) || otherRepo) {
              expanded.delete(sha);
              // Gone (the tree is clean): the host no longer needs to keep its list current.
              if (sha === WORKTREE_SHA) vscode.postMessage({ type: 'filesClosed', sha });
            } else if (sha === WORKTREE_SHA) {
              expanded.get(sha).lines = undefined;
              vscode.postMessage({ type: 'files', sha });
            }
          }
        }
        dataVersion++;
        maxWidth = Math.max(1, m.maxWidth);
        hasMore = m.hasMore;
        head = m.head;
        settings = { ...settings, ...m.settings };
        me = m.me || '';
        onGitHub = !!m.onGitHub;
        newSince = m.newSince || 0;
        statsRequested.clear();
        indexBySha = new Map(rows.map((r, i) => [r.sha, i]));
        repoName.textContent = m.repoName;
        setMultiRepo(m.multiRepo);
        updateToolbar();
        persist({ repoRoot: m.repoRoot, filter: m.filter });
        fillFilter(m.branches, m.filter);
        searchBox.dataset.active = m.search ? '1' : '';
        if (m.search) {
          modeSelect.value = m.search.mode;
          searchBox.value = m.search.text;
          matchInfo.textContent = `${rows.length}${hasMore ? '+' : ''} results`;
        }
        // Keep the selection where the commits still exist.
        const keep = (m.selection && m.selection.length ? m.selection : [...selected]).filter((s) => indexBySha.has(s));
        selected = new Set(keep);
        // The cursor stays on its commit; when that is gone (reworded, squashed, dropped) it keeps
        // its place in the list instead of jumping back to the top.
        if (prevCursorSha && indexBySha.has(prevCursorSha)) cursor = indexBySha.get(prevCursorSha);
        else if (keep.length) cursor = indexBySha.get(keep[keep.length - 1]);
        else cursor = prevCursor >= 0 && rows.length ? Math.min(prevCursor, rows.length - 1) : -1;
        anchor = cursor;
        if (highlight) computeMatches();
        computeBuckets();
        computeLines();
        applyColumns();
        if (m.keepScroll) scroller.scrollTop = prevTop;
        else if (firstLoad && saved.scrollTop) scroller.scrollTop = saved.scrollTop;
        // The editor graph starts in the commit list; the sidebar view never takes focus by itself.
        if (firstLoad && !settings.compact) scroller.focus();
        // Focused before the rows arrived (Ctrl+Alt+G V on a new view): start the cursor now.
        if (cursor < 0 && rows.length && document.activeElement === scroller) {
          cursor = 0;
          anchor = 0;
        }
        firstLoad = false;
        render();
        if (m.reveal) revealSha(m.reveal, true);
        else if (keep.length) notifySelection();
        else showPlaceholder();
        cursorChanged();
        break;
      }
      case 'worktree': {
        const i = indexBySha.get(WORKTREE_SHA);
        if (i === undefined) break;
        rows[i] = { ...rows[i], subject: m.subject, wt: m.wt };
        const entry = live.get(i);
        if (entry) {
          entry.el.remove();
          live.delete(i);
        }
        render();
        break;
      }
      case 'details':
        if (m.requestId !== undefined && m.requestId !== detailsRequest) break;
        renderDetails(m);
        break;
      case 'stats':
        for (const sha of m.failed || []) statsRequested.delete(sha); // asked again when next on screen
        for (const [sha, st] of Object.entries(m.stats || {})) stats.set(sha, st);
        for (const [i, entry] of live) {
          const cell = entry.el.querySelector('.cell.changes');
          if (cell && rows[i] && m.stats[rows[i].sha]) fillChanges(cell, rows[i].sha);
        }
        break;
      case 'focusSearch':
        showSearch();
        break;
      case 'focusList':
        scroller.focus();
        break;
      case 'viewed': {
        // Marks changed (here, in a tree, from a diff): bold goes or comes, counts follow.
        for (const k of m.viewed || []) vkState.set(k, true);
        for (const k of m.unviewed || []) vkState.set(k, false);
        for (const [sha, c] of Object.entries(m.counts || {})) {
          if (Array.isArray(c) && c[0] > 0) viewedCounts.set(sha, c);
          else viewedCounts.delete(sha);
        }
        for (const div of document.querySelectorAll('[data-vk]')) {
          const k = div.dataset.vk;
          if (vkState.has(k)) setUnviewed(div, settings.markUnviewed !== false && !vkState.get(k));
        }
        refreshViewedBadges();
        break;
      }
      case 'viewedSetting':
        settings.markUnviewed = !!m.on;
        viewedCounts.clear();
        for (const div of document.querySelectorAll('[data-vk]')) setUnviewed(div, false);
        refreshViewedBadges();
        if (m.on) {
          // Ask again (and draw the answer even when it is the same list as before).
          for (const [sha, e] of expanded) {
            e.filesKey = undefined;
            vscode.postMessage({ type: 'files', sha });
          }
          if (selected.size && !settings.compact) notifySelection();
          vscode.postMessage({ type: 'viewedCounts', shas: [...live.keys()].map((i) => rows[i] && rows[i].sha).filter((x) => x && x !== WORKTREE_SHA) });
        }
        break;
      case 'nextUnviewed': {
        // From the context menu: the next bold file after that one.
        const from = [...document.querySelectorAll('[data-vk]')].find((d) => {
          const c = JSON.parse(d.dataset.vscodeContext || '{}');
          return d.dataset.sha === m.sha && c.path === m.path && (m.group === undefined || c.group === m.group);
        });
        if (from) nextUnviewed(from);
        break;
      }
      case 'repoCount':
        setMultiRepo(m.multi);
        break;
      case 'oneView':
        settings.oneView = !!m.on;
        viewBtn.hidden = !m.on;
        break;
      case 'compareBase':
        if ((m.name || '') === compareBaseName) break;
        compareBaseName = m.name || '';
        // The tooltips name it: drawn again.
        for (const [, e] of expanded) e.lines = undefined;
        relayout();
        break;
      case 'collapseAll':
        collapseAll();
        break;
      case 'files': {
        // The changed files of an expanded commit (or of the working tree).
        const e = expanded.get(m.sha);
        if (!e || (m.repoRoot && m.repoRoot !== repoRoot)) break;
        // The same list again (a poll, a save that changed no file's status): nothing to redraw.
        const filesKey = JSON.stringify([m.files || [], m.parent, m.error]);
        if (filesKey === e.filesKey && e.lines && !e.refocus) {
          if (m.sha === WORKTREE_SHA && !e.draft) takeDraft(m.scmMessage);
          break;
        }
        e.filesKey = filesKey;
        e.files = m.files || [];
        countFromFiles(m.sha, e.files);
        refreshViewedBadges();
        e.parent = m.parent;
        e.error = m.error;
        // A message typed in Source Control: the empty box here takes it over (one draft).
        if (m.sha === WORKTREE_SHA && !e.draft) takeDraft(m.scmMessage);
        e.lines = undefined;
        relayout();
        // After a staging action: the keyboard on the same line (or the one now there) — only
        // while this page has it (a page you went on to, a summary, keeps it).
        if (e.refocus && !document.hasFocus()) e.refocus = undefined;
        if (e.refocus) {
          const i = indexBySha.get(m.sha);
          const box = i !== undefined && liveFiles.get(i);
          const lines = box ? [...box.el.querySelectorAll('.file-line.file, .file-line.folder')] : [];
          if (e.refocus.commit) {
            const input = box && box.el.querySelector('.commit-message');
            if (input && document.activeElement !== input) input.focus();
          } else if (lines.length) {
            let target;
            for (const want of e.refocus.prefer || []) if (!target) target = findLine(lines, want);
            (target || lines[Math.min(e.refocus.index, lines.length - 1)]).focus();
          }
          else if (i !== undefined) {
            cursor = i;
            scroller.focus();
          }
          e.refocus = undefined;
        }
        break;
      }
      case 'wtCommitted': {
        // Committed: the message is used up (Source Control's box was emptied by the commit
        // itself: nothing to send back, which would replace its commit template).
        const e = expanded.get(WORKTREE_SHA);
        persist({ wtDraft: { repoRoot, text: '' } });
        if (!e) break;
        e.draft = '';
        if (e.commitEl) /** @type {HTMLTextAreaElement} */ (e.commitEl.querySelector('.commit-message')).value = '';
        e.lines = undefined;
        relayout();
        break;
      }
      case 'wtMessage':
        onGeneratedMessage(m);
        break;
      case 'draftSet':
        // Typed in the other graph, or Source Control's (asked for when this box got the keyboard).
        if (m.repoRoot === repoRoot) takeDraft(m.text);
        break;
      case 'wtDone': {
        // The staging action is over: the commit box takes input again. ("busy": an action sent
        // while another ran was refused; that other one answers when it is done.)
        if (m.busy) break;
        const e = expanded.get(WORKTREE_SHA);
        if (e) {
          e.busy = false;
          syncCommitBox(e);
        }
        break;
      }
      case 'activitySummary':
        renderSummary(m.activity);
        break;
      case 'worktreeWip':
        wipBySha = m.wip && typeof m.wip === 'object' ? m.wip : {};
        dataVersion++;
        scheduleRender();
        break;
      case 'append': {
        const start = rows.length;
        rows = rows.concat(m.rows);
        m.rows.forEach((r, i) => indexBySha.set(r.sha, start + i));
        hasMore = m.hasMore;
        if (m.maxWidth !== maxWidth) {
          maxWidth = Math.max(1, m.maxWidth);
          dataVersion++; // lane column width changed: redraw rows
          applyColumns();
        }
        computeBuckets();
        computeLines();
        if (highlight) computeMatches();
        render();
        break;
      }
      default:
        break;
    }
  });

  // Keyboard help overlay ("?").
  const help = el('div', 'help-overlay');
  help.setAttribute('role', 'dialog');
  help.setAttribute('aria-label', 'Keyboard shortcuts');
  /** The keys of the mode shown: the sidebar is a tree with no details pane. */
  function helpRows() {
    const common = [
      ['Shift + arrows', 'extend the selection'], ['Ctrl/Cmd+A', 'select all'],
      ['Ctrl+↑ ↓, Ctrl+Space', 'move without selecting, toggle a commit'],
      ['Enter', 'open the changes of the selection'],
      ['Shift+F10 / Menu key', 'context menu (same as right-click)'], ['.', 'actions as a searchable list'],
      // The staging area: the uncommitted changes, expanded.
      ['→ on Uncommitted changes', 'the staging area: first the commit message (Enter commits, Shift+Enter new line, ↓ to the files)'],
      ['+ or S / − or U', 'stage / unstage the file or group'], ['Delete or D', 'discard the file or group (asks first)'],
      // Any file row.
      ['O / W on a file', 'open the working file (at the line of its open diff) / compare with it'],
      ['B / Shift+B on a file', 'compare with the base branch (the one you last picked with Shift+B, else origin\'s default branch) / pick a branch, tag or commit'],
      ['N / V on a file', 'next file not opened yet (bold) / viewed on or off'],
    ];
    if (settings.compact) {
      return [
        ['↑ ↓ PgUp PgDn Home End', 'move (through the files of open commits too)'],
        ['→ / ←', "open / close a commit's changed files; on a file: Enter opens its diff, Space previews it (the keyboard stays here), ← back to the commit"],
        ...common,
        ['Space', 'preview the changes of the commit at the cursor'],
        ['Esc', 'clear the search'],
        ['Ctrl/Cmd+C', 'copy SHAs'], ['Ctrl/Cmd+F', 'search'], ['?', 'this help'],
      ];
    }
    return [
      ['↑ ↓ PgUp PgDn Home End', 'move (through the files of open commits too)'],
      ['→ / ←', "open / close a commit's changed files under it; on a file: Enter opens its diff, Space previews it, ← back"],
      ...common,
      ['Space', 'select only the commit at the cursor'],
      ['Esc', 'clear the search; in the details pane: back to the list'],
      ['Ctrl/Cmd+C', 'copy SHAs'], ['Ctrl/Cmd+F', 'search'], ['Tab', 'into an expanded commit\'s files, else the details pane (↑ ↓ between files, Enter opens, Esc back)'], ['?', 'this help'],
    ];
  }
  function fillHelp() {
    help.replaceChildren(el('h2', '', 'Keyboard shortcuts'));
    for (const [k, d] of helpRows()) {
      const row = el('div', 'help-row');
      row.append(el('kbd', '', k), el('span', '', d));
      help.appendChild(row);
    }
    help.appendChild(el('div', 'note', 'Esc or ? closes this help.'));
  }
  help.tabIndex = -1;
  help.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === '?') {
      e.preventDefault();
      toggleHelp();
    } else if (e.key === 'Tab') {
      e.preventDefault(); // modal: keep focus inside until it is closed
    }
  });
  document.body.appendChild(help);
  function toggleHelp() {
    const show = !help.classList.contains('visible');
    if (show) fillHelp();
    help.classList.toggle('visible', show);
    if (show) help.focus();
    else scroller.focus();
  }
  const helpBtn = button('', 'Keyboard shortcuts (?)', () => toggleHelp(), 'help');
  toolbar.appendChild(helpBtn);

  vscode.postMessage({ type: 'ready' });
})();
