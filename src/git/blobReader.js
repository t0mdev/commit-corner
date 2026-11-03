'use strict';

const { spawnGit } = require('./exec');

/**
 * A long-lived `git cat-file --batch` process for reading blobs at fixed
 * revisions. Opening a commit or PR with hundreds of files in the
 * multi-diff editor then costs one process instead of one per file side.
 *
 * Only used for immutable specs ("<sha>:path", "<sha>^:path"): the batch
 * process reads the index and refs once, so mutable specs (":path", "HEAD:")
 * go through one-shot commands instead.
 */
class BlobReader {
  constructor(cwd) {
    this.cwd = cwd;
    this.proc = undefined;
    this.pending = [];
    /** Unparsed output: a list of chunks (concatenating per chunk would be quadratic for big blobs). */
    this.chunks = [];
    this.length = 0;
  }

  /** Concatenate buffered chunks only when needed, and only once. */
  buffer() {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks, this.length)];
    return this.chunks[0] || Buffer.alloc(0);
  }

  consume(n) {
    const b = this.buffer().subarray(n);
    this.chunks = b.length ? [b] : [];
    this.length = b.length;
  }

  start() {
    const proc = spawnGit(['cat-file', '--batch'], { cwd: this.cwd });
    proc.stdout.on('data', (d) => {
      this.chunks.push(d);
      this.length += d.length;
      // Waiting for the rest of a large object: don't touch the buffer until it is complete.
      if (this.need && this.length < this.need) return;
      this.drain();
    });
    const fail = () => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      this.chunks = [];
      this.length = 0;
      this.need = 0;
      const pending = this.pending;
      this.pending = [];
      for (const p of pending) p.reject(new Error('git cat-file --batch exited'));
    };
    proc.on('error', fail);
    proc.on('close', fail);
    proc.stdin.on('error', () => {});
    this.proc = proc;
    this.idle();
  }

  /** An idle reader must not keep the process (or a test run) alive; a busy one must. */
  idle() {
    if (!this.proc) return;
    this.proc.unref();
    for (const s of [this.proc.stdin, this.proc.stdout, this.proc.stderr]) if (s && s.unref) s.unref();
  }

  busy() {
    if (!this.proc) return;
    this.proc.ref();
    for (const s of [this.proc.stdin, this.proc.stdout, this.proc.stderr]) if (s && s.ref) s.ref();
  }

  /** Parse as many complete responses as the buffer holds. */
  drain() {
    this.need = 0;
    while (this.pending.length && this.length) {
      const buf = this.buffer();
      const nl = buf.indexOf(10);
      if (nl < 0) return;
      const header = buf.subarray(0, nl).toString('utf8');
      const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
      if (!m) {
        // "<spec> missing" / "<spec> ambiguous": no content follows.
        this.consume(nl + 1);
        this.pending.shift().resolve(null);
        continue;
      }
      const total = nl + 1 + Number(m[2]) + 1; // header, content, trailing LF
      if (buf.length < total) {
        this.need = total;
        return;
      }
      const content = Buffer.from(buf.subarray(nl + 1, total - 1));
      this.consume(total);
      this.pending.shift().resolve(m[1] === 'blob' ? content : null);
    }
  }

  /** @returns {Promise<Buffer|null>} */
  read(spec) {
    if (/[\n\r]/.test(spec)) return Promise.reject(new Error('unsupported path for batch read'));
    if (!this.proc) this.start();
    return new Promise((resolve, reject) => {
      const done = (fn) => (v) => {
        if (!this.pending.length) this.idle();
        fn(v);
      };
      if (!this.pending.length) this.busy();
      this.pending.push({ resolve: done(resolve), reject: done(reject) });
      this.proc.stdin.write(`${spec}\n`);
    });
  }

  dispose() {
    if (this.proc) {
      const p = this.proc;
      this.proc = undefined;
      p.stdin.end();
      p.kill();
    }
  }
}

module.exports = { BlobReader };
