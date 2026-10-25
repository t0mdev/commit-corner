'use strict';

/**
 * Commit graph lane layout.
 *
 * Input: commits in topological order (children before parents), each with
 * `sha` and `parents`. Output: one row per commit describing where its node
 * sits and which line segments cross that row, so the webview can draw each
 * row independently (which keeps rendering virtualizable).
 *
 * Segment kinds (x values are lane indices):
 *   pass: lane continues through the row,   top(from) -> bottom(to)
 *   in:   lane terminates at this node,      top(from) -> node
 *   out:  edge from this node to a parent,   node -> bottom(to)
 */

const COLOR_COUNT = 10;

class GraphLayout {
  constructor() {
    /** @type {{sha:string, color:number}[]} */
    this.lanes = [];
    this.nextColor = 0;
    this.maxWidth = 0;
  }

  newColor() {
    const c = this.nextColor;
    this.nextColor = (this.nextColor + 1) % COLOR_COUNT;
    return c;
  }

  /**
   * Lay out the next batch of commits. Can be called repeatedly to extend an
   * existing layout (paging) as long as commits keep arriving in topo order.
   * @param {{sha:string, parents:string[]}[]} commits
   */
  add(commits) {
    const rows = [];
    for (const commit of commits) rows.push(this.addOne(commit));
    return rows;
  }

  addOne(commit) {
    const before = this.lanes;
    const incoming = [];
    for (let i = 0; i < before.length; i++) if (before[i].sha === commit.sha) incoming.push(i);

    /** @type {({sha:string,color:number}|null)[]} */
    const next = before.slice();
    let col;
    let color;
    if (incoming.length) {
      col = incoming[0];
      color = before[col].color;
    } else {
      // A branch tip nobody was waiting for: open a lane for it. The slot stays empty
      // unless the first parent claims it below.
      col = next.length;
      color = this.newColor();
      next.push(null);
    }
    for (const i of incoming) next[i] = null;

    /** @type {{target:number, color:number}[]} lanes (indices in `next`) the node connects down to */
    const outs = [];
    /** Lanes (indices in `before`) that are folded into another lane at the bottom of this row. */
    const redirect = new Map();
    const parents = commit.parents || [];
    parents.forEach((p, pi) => {
      const existing = next.findIndex((l) => l && l.sha === p);
      if (existing >= 0 && pi === 0 && existing > col) {
        // Our first parent is already awaited further right: keep the line straight here and fold
        // the right-hand lane into ours instead, so first-parent chains stay vertical.
        next[existing] = null;
        redirect.set(existing, col);
        next[col] = { sha: p, color };
        outs.push({ target: col, color });
        return;
      }
      if (existing >= 0) {
        outs.push({ target: existing, color: pi === 0 ? color : next[existing].color });
        return;
      }
      if (pi === 0) {
        next[col] = { sha: p, color };
        outs.push({ target: col, color });
        return;
      }
      // New lane for an additional merge parent: reuse a hole right of the node if any.
      let slot = -1;
      for (let i = col + 1; i < next.length; i++) if (next[i] === null) { slot = i; break; }
      const lane = { sha: p, color: this.newColor() };
      if (slot < 0) {
        slot = next.length;
        next.push(lane);
      } else next[slot] = lane;
      outs.push({ target: slot, color: lane.color });
    });

    // Compact holes so the graph stays narrow.
    const map = new Array(next.length);
    const after = [];
    for (let i = 0; i < next.length; i++) {
      if (next[i]) {
        map[i] = after.length;
        after.push(next[i]);
      }
    }

    const lines = [];
    for (let i = 0; i < before.length; i++) {
      if (incoming.includes(i)) lines.push({ kind: 'in', from: i, to: col, color: before[i].color });
      else lines.push({ kind: 'pass', from: i, to: map[redirect.has(i) ? redirect.get(i) : i], color: before[i].color });
    }
    for (const o of outs) lines.push({ kind: 'out', from: col, to: map[o.target], color: o.color });

    this.lanes = after;
    const width = Math.max(before.length, after.length, col + 1);
    if (width > this.maxWidth) this.maxWidth = width;
    return { col, color, lines, width, isMerge: parents.length > 1, isRoot: parents.length === 0 };
  }
}

/** Convenience for one-shot layouts (tests, small histories). */
function layout(commits) {
  const g = new GraphLayout();
  const rows = g.add(commits);
  return { rows, maxWidth: g.maxWidth };
}

module.exports = { GraphLayout, layout, COLOR_COUNT };
