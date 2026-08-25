// @ts-check
/* Guards the zero-copy shard open in js/db-worker.js queryCloseBuffer.
   ---------------------------------------------------------------------------
   WHAT IS GUARDED
     `new SQL.Database(bytes)` normally makes a SECOND full copy of the shard:
     the vendored sql-wasm.js reaches MEMFS with canOwn hard-wired to
     `undefined`, so MEMFS takes `buf.slice(off, off+len)` instead of
     `buf.subarray(off, off+len)`. queryCloseBuffer suppresses that by
     shadowing `.slice` with an own property on the one array it hands to
     sql.js. See the comment block there for the full mechanism and its limit.

   HOW IT IS GUARDED
     These tests do not read the source and hope. They fetch the REAL
     js/db-worker.js at run time, run it in a Blob worker with
     Uint8Array.prototype.slice counting every allocation over 1 MB, and drive
     it through the real message protocol with a real 28 MB shard. Because the
     worker source is fetched rather than duplicated, this file cannot drift
     away from production.

   NEGATIVE CONTROL
     Every test also builds a SECOND worker from the same fetched source with
     the fix textually removed, and requires the copy to reappear there. So the
     assertion is never trivially green: if the copy stops being suppressed,
     the two workers agree and the guard fails.

     Both failure modes were provoked for real on 2026-07-27 and these are the
     verbatim outputs, not predictions.

     (a) Fix DELETED from js/db-worker.js (`git checkout -- js/db-worker.js`) —
         all three tests fail before they measure anything, pointing at this
         file rather than at the worker:

           Error: page.evaluate: Error: negative control cannot be built: the
           fix pattern was not found in js/db-worker.js — update FIX_RE in this
           spec
               at window.__bootWorkers (<anonymous>:80:15)
               at openHarness (tests\shard-memory.spec.js:154:27)

     (b) Fix PRESENT but neutered — the `bytes.slice` assignment left in place
         with its body replaced by a plain
         `Uint8Array.prototype.slice.call(this, begin, end)`. This is the case
         that matters: the source still looks right, the control still builds,
         and only the measurement catches it. Test 1 failed with:

           Error: the fix is not in effect: sql.js still copied the shard
           expect(received).toEqual(expected) // deep equality
           - Expected  - 1
           + Received  + 3
           - Array []
           + Array [
           +   29564928,
           + ]
             > 186 |       'the fix is not in effect: sql.js still copied the
                            shard').toEqual([]);
               at tests\shard-memory.spec.js:186:66

         Tests 2 and 3 stayed green there, exactly as they should: the control
         still copies, and the results still match.

     (c) SELECT-only guard removed (the two `assertReadOnlySql` calls deleted):

           Error: a write statement reached a zero-copy shard
           expect(received).not.toBeNull()
           Received: null
             > 324 |       expect(err, 'a write statement reached a zero-copy
                            shard').not.toBeNull();
           Error: countSql bypassed the read-only guard
           expect(received).not.toBeNull()
           Received: null
             > 345 |     expect(err, 'countSql bypassed the read-only
                            guard').not.toBeNull();

     (d) The shadow pasted into openGz — the precise use-after-free this file
         is meant to prevent, since openGz parks the handle in `databases`
         while the caller drops the buffer:

           Error: more than one .slice shadow in db-worker.js — the shard trick
           has been copied somewhere else; see the LIMIT note in
           queryCloseBuffer
           expect(received).toBe(expected) // Object.is equality
           Expected: 1
           Received: 2
               at tests\shard-memory.spec.js:373:10

         and every other test in this file stopped early with
           "negative control cannot be built: expected exactly 1 `bytes.slice`
            shadow in js/db-worker.js, found 2".

         NOTE for whoever changes FIX_RE: the first attempt at (d) did NOT
         report this. With a plain `.test()` the single lazy match ran from the
         openGz occurrence to the closing brace of the queryCloseBuffer one and
         stripped the code in between, so the control worker hung and the suite
         reported a bare 90 s timeout. Counting the matches instead of testing
         for one is what turns that into the message above.

     (e) `PRAGMA query_only = 1` removed, the assertReadOnlySql sieve LEFT IN
         PLACE — i.e. exactly the state Codex flagged as HIGH. The WITH-
         prefixed write walks through the regex untouched:

           Error: WITH_DELETE was NOT refused — a write reached a zero-copy
           shard
           expect(received).not.toBeNull()
           Received: null
             > 506 |           .not.toBeNull();
               at tests\shard-memory.spec.js:506:16

         This is the one that matters: it shows the regex alone never
         protected anything, and the engine pragma is what does.

     (f) sw-precache.js pointed at a different db-worker version than js/db.js
         (`?v=deadbeef` vs `?v=4ffdf156`) — every test in this file stopped
         with:

           Error: cache-bust drift: js/db.js loads "js/db-worker.js?v=4ffdf156"
           but sw-precache.js does not precache that exact string — run
           scripts/cache_bust.py. Installed clients would run a different
           db-worker.js than this test just checked.
   =========================================================================== */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// Real manifest from disk — shard COUNT, PATH and ENCODING are all
// generation-dependent (the corpus regenerated 2026-07-27: 21 gzip shards ->
// 22 Brotli shards). Hardcoding any of the three here is exactly the defect
// this rework removes: re-generating the corpus must not require editing this
// file, only the golden match-count below (which is corpus CONTENT, not
// corpus FORM, and is called out on its own as intentionally coupled).
const MANIFEST_PATH = path.join(__dirname, '..', 'data', 'manifest.json');
const realManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const REAL_SHARDS = realManifest.sentenceShards || [];
const SHARD_COUNT = REAL_SHARDS.length;
const SHARD_0_ENTRY = REAL_SHARDS[0];
const SHARD_0 = '/' + SHARD_0_ENTRY.path.replace(/^\/?/, '');
const SHARD_0_ENC = SHARD_0_ENTRY.enc || 'gzip';

// Anchored on the assignment itself, not on any comment, so re-wording the
// explanation above queryCloseBuffer cannot silently disarm the control.
const FIX_RE = /\r?\n[ \t]*bytes\.slice = function \(begin, end\) \{[\s\S]*?\r?\n[ \t]*\};\r?\n/;

const SQL_TEXT =
  'SELECT s.ts, s.nr, s.seq, s.sentence FROM sentences s ' +
  'WHERE (s.sentence_search LIKE $tw0) LIMIT 200';
const COUNT_TEXT =
  'SELECT COUNT(*) AS n, COUNT(DISTINCT s.nr) AS lectures FROM sentences s ' +
  'WHERE (s.sentence_search LIKE $tw0)';
const PARAMS = { $tw0: '% krishna%' };

/* Page-side harness. Installed once per page; every helper below runs inside
   the browser because the shard buffers must never cross the CDP boundary. */
async function installHarness(page) {
  await page.addInitScript(() => {
    /** Build a Blob worker from `src`, instrumented to count big allocations. */
    window.__makeWorker = function (name, src, base) {
      const preamble = `
        var __BASE = ${JSON.stringify(base)};
        var __origImport = importScripts;
        // db-worker.js imports 'vendor/sql-wasm.js' and 'codec.js' relative to
        // its own URL; from a blob: worker those would not resolve, so rewrite
        // them against the real /js/ base.
        importScripts = function () {
          var abs = Array.prototype.map.call(arguments, function (u) {
            return new URL(u, __BASE).href;
          });
          return __origImport.apply(self, abs);
        };
        // codec.js lazy-loads the Brotli decoder with a PLAIN relative fetch
        // ('vendor/brotli-dec.wasm', resolved against the worker's own URL —
        // exactly like WASM_CDN below, and fine in a real production worker
        // whose URL is a real 'js/db-worker.js?v=...' path). A blob: worker's
        // location cannot resolve a bare relative path at all ("Failed to
        // parse URL from vendor/brotli-dec.wasm"), so rewrite any relative
        // fetch() the same way importScripts already is above. Absolute
        // (leading '/') requests — the actual shard/data fetches this spec
        // makes — resolve unchanged: new URL('/x', base) keeps the origin
        // and ignores base's path.
        var __origFetch = fetch;
        fetch = function (input, init) {
          if (typeof input === 'string' && !/^[a-z]+:/i.test(input)) {
            input = new URL(input, __BASE).href;
          }
          return __origFetch(input, init);
        };
        var __bigSlices = [];
        var __origSlice = Uint8Array.prototype.slice;
        Uint8Array.prototype.slice = function () {
          var r = __origSlice.apply(this, arguments);
          if (r.byteLength > 1048576) __bigSlices.push(r.byteLength);
          return r;
        };
      `;
      const postamble = `
        // Same reason as importScripts: locateFile returns a relative path.
        WASM_CDN = new URL('vendor/sql-wasm.wasm', __BASE).href;
        var __app = self.onmessage;
        self.onmessage = function (e) {
          var d = e.data;
          if (d && d.cmd === '__slices') {
            self.postMessage({ id: d.id, cmd: '__slices', result: __bigSlices.slice() });
            return;
          }
          if (d && d.cmd === '__reset') {
            __bigSlices.length = 0;
            self.postMessage({ id: d.id, cmd: '__reset', result: true });
            return;
          }
          /* Run one statement through the REAL queryCloseBuffer and report
             whether the caller's bytes moved underneath it. The buffer is
             cloned into this worker (not transferred), so what we inspect is
             exactly what queryCloseBuffer's caller holds while MEMFS aliases
             it — the corruption path itself, not a model of it. */
          if (d && d.cmd === '__writeProbe') {
            initEngine().then(function () {
              var N = Math.min(d.buffer.byteLength, 65536);
              var before = Uint8Array.prototype.slice.call(new Uint8Array(d.buffer), 0, N);
              var err = null, rows = null;
              try {
                var r = queryCloseBuffer(d.buffer, d.sql, null, null);
                rows = r && r.rows ? r.rows.length : 0;
              } catch (e) { err = String(e && e.message || e); }
              var after = Uint8Array.prototype.slice.call(new Uint8Array(d.buffer), 0, N);
              var changed = false, at = -1;
              for (var i = 0; i < N; i++) {
                if (before[i] !== after[i]) { changed = true; at = i; break; }
              }
              self.postMessage({ id: d.id, cmd: '__writeProbe',
                result: { changed: changed, at: at, err: err, rows: rows } });
            }).catch(function (e) {
              self.postMessage({ id: d.id, cmd: '__writeProbe', error: String(e && e.message || e) });
            });
            return;
          }
          return __app.call(self, e);
        };
      `;
      const url = URL.createObjectURL(
        new Blob([preamble, src, postamble], { type: 'application/javascript' }));
      const w = new Worker(url);
      const pending = new Map();
      let seq = 0;
      w.onmessage = function (e) {
        const m = e.data;
        if (m && m.id != null && pending.has(m.id)) {
          const r = pending.get(m.id); pending.delete(m.id);
          m.error ? r.rej(new Error(m.error)) : r.res(m.result);
        }
      };
      window['__w_' + name] = {
        call: function (msg, transfer) {
          const id = ++seq;
          return new Promise(function (res, rej) {
            pending.set(id, { res, rej });
            const full = Object.assign({ id }, msg);
            transfer ? w.postMessage(full, transfer) : w.postMessage(full);
          });
        }
      };
    };

    /* The URL PRODUCTION loads, derived the way production derives it.
       Fetching a bare '/js/db-worker.js' would let this whole file stay green
       while the versioned artefact the app and the service worker actually
       load is a stale one — measuring the wrong file, which has already cost
       hours twice today. So: read the literal out of js/db.js, and require the
       service-worker precache list to name the same one. */
    window.__productionWorkerUrl = async function () {
      const dbjs = await (await fetch('/js/db.js')).text();
      const m = dbjs.match(/new Worker\(\s*['"]([^'"]*db-worker\.js[^'"]*)['"]\s*\)/);
      if (!m) {
        throw new Error('cannot derive the production worker URL: no ' +
          '`new Worker("js/db-worker.js?v=...")` literal in js/db.js — ' +
          'update this spec to match how db.js now builds it');
      }
      const url = '/' + m[1].replace(/^\.?\//, '');
      const sw = await (await fetch('/sw-precache.js')).text();
      if (sw.indexOf(m[1]) === -1) {
        throw new Error('cache-bust drift: js/db.js loads "' + m[1] +
          '" but sw-precache.js does not precache that exact string — run ' +
          'scripts/cache_bust.py. Installed clients would run a different ' +
          'db-worker.js than this test just checked.');
      }
      return url;
    };

    /** Fetch production db-worker.js and spin up FIXED + CONTROL workers. */
    window.__bootWorkers = async function (fixReSource) {
      const base = new URL('/js/', location.href).href;
      const workerUrl = await window.__productionWorkerUrl();
      const src = await (await fetch(workerUrl)).text();
      const fixRe = new RegExp(fixReSource.source, fixReSource.flags);
      // Count, don't just test. If the shadow ever appears twice, a single
      // lazy match spans from the first occurrence to the second one's closing
      // brace and strips real code in between — the control worker then hangs
      // and the suite reports a 90 s timeout instead of the actual mistake.
      // Observed for real while negative-checking the openGz guard.
      const all = src.match(new RegExp(fixRe.source, 'g')) || [];
      if (all.length !== 1) {
        throw new Error('negative control cannot be built: expected exactly 1 ' +
          '`bytes.slice` shadow in js/db-worker.js, found ' + all.length +
          (all.length === 0
            ? ' — the fix is gone, or FIX_RE in this spec is stale'
            : ' — the shard trick has been copied to another function; see the ' +
              'LIMIT note in queryCloseBuffer'));
      }
      const stripped = src.replace(fixRe, '\n');
      window.__makeWorker('fixed', src, base);
      window.__makeWorker('control', stripped, base);

      /* UNGUARDED: the shadow kept, but BOTH write guards removed — the regex
         sieve and `PRAGMA query_only = 1`. This is the only way to show what
         the guards are actually buying: with it, a write reaches SQLite
         through the aliased buffer and the caller's bytes change underneath
         it. Without this worker the write tests could pass for the wrong
         reason (e.g. the write failing for some unrelated reason). */
      let unguarded = src
        .replace(/^[ \t]*assertReadOnlySql\([^)]*\);[ \t]*\r?\n/gm, '')
        .replace(/^[ \t]*if \(countSql\) assertReadOnlySql\([^)]*\);[ \t]*\r?\n/gm, '')
        .replace(/^[ \t]*db\.run\('PRAGMA query_only = 1'\);[ \t]*\r?\n/gm, '');
      if (unguarded.indexOf('query_only') !== -1 &&
          unguarded.indexOf("db.run('PRAGMA query_only = 1')") !== -1) {
        throw new Error('could not build the UNGUARDED worker: the ' +
          'query_only line did not match — update this spec');
      }
      if (/^[ \t]*assertReadOnlySql\(sql/m.test(unguarded)) {
        throw new Error('could not build the UNGUARDED worker: the ' +
          'assertReadOnlySql call did not match — update this spec');
      }
      window.__makeWorker('unguarded', unguarded, base);

      return { srcLen: src.length, strippedLen: stripped.length,
               unguardedLen: unguarded.length, workerUrl };
    };

    /** compressed shard URL -> decompressed ArrayBuffer, in the page.
        Goes through window.PPP.codec (codec.js, loaded by tests/blank.html)
        so it decodes whichever codec the manifest actually declares for this
        entry — gzip or Brotli — the same way production does, instead of
        hardcoding DecompressionStream('gzip') for a codec the corpus may not
        even be using anymore. */
    window.__rawShard = async function (url, enc) {
      const compressed = await (await fetch(url)).arrayBuffer();
      return await window.PPP.codec.toArrayBuffer(compressed, enc || 'gzip', 'test shard');
    };
  });
}

/** A blank same-origin page is all we need — no app boot, no DB download. */
async function openHarness(page) {
  await installHarness(page);
  await page.goto('/tests/blank.html');
  const info = await page.evaluate(async (re) => window.__bootWorkers(re),
    { source: FIX_RE.source, flags: FIX_RE.flags });
  expect(info.strippedLen,
    'negative control is not a control: stripping the fix changed nothing')
    .toBeLessThan(info.srcLen);
  expect(info.unguardedLen,
    'the UNGUARDED control is not a control: removing both write guards ' +
    'changed nothing')
    .toBeLessThan(info.srcLen);
  return info;
}

test.describe('shard open does not copy the database (db-worker queryCloseBuffer)', () => {

  test('production worker opens a 28 MB shard with NO second copy', async ({ page }) => {
    await openHarness(page);

    const out = await page.evaluate(async (o) => {
      const raw = await window.__rawShard(o.shard, o.enc);
      const rawLen = raw.byteLength;
      const fixed = window['__w_fixed'];
      await fixed.call({ cmd: '__reset' });
      const res = await fixed.call(
        { cmd: 'queryCloseBuffer', buffer: raw, sql: o.sql, countSql: o.countSql, params: o.params },
        [raw]);
      const slices = await fixed.call({ cmd: '__slices' });
      return { rawLen, slices, rows: res.rows.length, n: res.count[0].n };
    }, { shard: SHARD_0, enc: SHARD_0_ENC, sql: SQL_TEXT, countSql: COUNT_TEXT, params: PARAMS });

    // Sanity: we really did hand it a full-size shard and it really answered.
    expect(out.rawLen).toBeGreaterThan(20 * 1024 * 1024);
    expect(out.rows).toBeGreaterThan(0);
    expect(out.n).toBeGreaterThan(0);

    // The whole point: not one allocation the size of the shard.
    expect(out.slices,
      'the fix is not in effect: sql.js still copied the shard').toEqual([]);
  });

  test('NEGATIVE CONTROL: without the fix the same shard IS copied', async ({ page }) => {
    await openHarness(page);

    const out = await page.evaluate(async (o) => {
      const raw = await window.__rawShard(o.shard, o.enc);
      const rawLen = raw.byteLength;
      const control = window['__w_control'];
      await control.call({ cmd: '__reset' });
      const res = await control.call(
        { cmd: 'queryCloseBuffer', buffer: raw, sql: o.sql, countSql: o.countSql, params: o.params },
        [raw]);
      const slices = await control.call({ cmd: '__slices' });
      return { rawLen, slices, rows: res.rows.length, n: res.count[0].n };
    }, { shard: SHARD_0, enc: SHARD_0_ENC, sql: SQL_TEXT, countSql: COUNT_TEXT, params: PARAMS });

    // Exactly one allocation, exactly the size of the shard: that is the
    // MEMFS `buf.slice(0, len)` the fix removes. If this ever stops firing the
    // guard above has become meaningless and must be re-derived.
    expect(out.slices,
      'negative control did not reproduce the copy — the guard above proves nothing now')
      .toEqual([out.rawLen]);
    expect(out.rows).toBeGreaterThan(0);
  });

  test('results are bit-identical with and without the fix, across all manifest shards',
    async ({ page }) => {
      test.setTimeout(180000);   // N shards x 2 workers, ~28 MB each
      await openHarness(page);

      // Path AND encoding come from the manifest per shard, not a
      // reconstructed filename with a hardcoded '.db.gz' suffix — the corpus
      // regenerated 2026-07-27 from 21 gzip shards to 22 Brotli ones, and a
      // rebuilt filename would 404 the moment either the count or the codec
      // changes again.
      const shardList = REAL_SHARDS.map(function (s) {
        return { url: '/' + String(s.path).replace(/^\/?/, ''), enc: s.enc || 'gzip' };
      });

      const out = await page.evaluate(async (o) => {
        async function sweep(which) {
          const w = window['__w_' + which];
          let n = 0, lectures = 0, rows = 0;
          const perShard = [];
          for (const shard of o.shards) {
            const buf = await (await fetch(shard.url)).arrayBuffer();
            // openQueryClose = the real production entry point: the worker
            // decompresses through PPPCodec (gzip or Brotli, per shard.enc)
            // and calls queryCloseBuffer itself.
            const res = await w.call(
              { cmd: 'openQueryClose', buffer: buf, sql: o.sql, countSql: o.countSql,
                params: o.params, enc: shard.enc }, [buf]);
            n += res.count[0].n;
            lectures += res.count[0].lectures;
            rows += res.rows.length;
            perShard.push(res.count[0].n);
          }
          return { n, lectures, rows, perShard };
        }
        return { fixed: await sweep('fixed'), control: await sweep('control') };
      }, { shards: shardList, sql: SQL_TEXT, countSql: COUNT_TEXT, params: PARAMS });

      // Invariant — true for any corpus: removing the copy changes nothing.
      expect(out.fixed.perShard).toEqual(out.control.perShard);
      expect(out.fixed.n).toEqual(out.control.n);
      expect(out.fixed.lectures).toEqual(out.control.lectures);
      expect(out.fixed.rows).toEqual(out.control.rows);

      // Golden value for the corpus generation currently in staging/data/
      // (re-measured 2026-08-25 against the 23-shard generation synced from
      // production deploy/ — was 421417 for the prior 22-shard Brotli one,
      // 416028 before that for the 21-shard gzip generation). This one line
      // is corpus-coupled ON PURPOSE — a silent change in shard content
      // should stop the gate. Rebuilt the sentence shards? Re-measure and
      // update HERE, and nowhere else in this file.
      expect(out.fixed.n,
        'total matches for "% krishna%" changed — corpus rebuilt, or the shard ' +
        'search regressed').toBe(323626);
    });
});

test.describe('the zero-copy shard open cannot be turned into a write', () => {

  /* The shadow makes MEMFS alias the caller's buffer. A SELECT reads it; an
     INSERT / VACUUM / PRAGMA-with-write would write straight back through it
     and corrupt a buffer the caller still owns. queryCloseBuffer therefore
     refuses anything that is not SELECT / WITH. Without that check the failure
     would be silent data corruption, which is the one failure mode this whole
     optimisation must not be able to cause. */

  test('a write statement is refused before the shard is even opened', async ({ page }) => {
    await openHarness(page);

    const out = await page.evaluate(async (o) => {
      const raw = await window.__rawShard(o.shard, o.enc);
      const before = new Uint8Array(raw.slice(0, 4096));   // header snapshot
      const fixed = window['__w_fixed'];
      const attempts = [
        'DELETE FROM sentences',
        'INSERT INTO sentences (nr,seq,ts,ts_end,sentence,sentence_search) ' +
          "VALUES (1,1,'','','x','x')",
        'VACUUM',
        'UPDATE sentences SET sentence = \'\'',
        'PRAGMA user_version = 7',
        'CREATE TABLE t (a)'
      ];
      const errors = [];
      for (const sql of attempts) {
        try {
          await fixed.call({ cmd: 'queryCloseBuffer', buffer: raw, sql, countSql: null, params: null });
          errors.push(null);                       // accepted — that is the bug
        } catch (e) { errors.push(String(e.message)); }
      }
      // The buffer was NOT transferred above, so it is still ours: prove the
      // rejected calls left it untouched.
      const after = new Uint8Array(raw.slice(0, 4096));
      let identical = before.length === after.length;
      for (let i = 0; identical && i < before.length; i++) {
        if (before[i] !== after[i]) identical = false;
      }
      // And prove the guard is not simply refusing everything.
      const ok = await fixed.call({ cmd: 'queryCloseBuffer', buffer: raw,
        sql: o.sql, countSql: o.countSql, params: o.params });
      return { errors, identical, okRows: ok.rows.length, okN: ok.count[0].n };
    }, { shard: SHARD_0, enc: SHARD_0_ENC, sql: SQL_TEXT, countSql: COUNT_TEXT, params: PARAMS });

    for (const err of out.errors) {
      expect(err, 'a write statement reached a zero-copy shard').not.toBeNull();
      expect(err).toMatch(/refuses a non-read-only/);
    }
    expect(out.identical,
      "a refused write still altered the caller's buffer").toBe(true);

    // Negative side of the same test: the guard must not be a blanket refusal.
    expect(out.okRows).toBeGreaterThan(0);
    expect(out.okN).toBeGreaterThan(0);
  });

  test('countSql is guarded too, not just sql', async ({ page }) => {
    await openHarness(page);
    const err = await page.evaluate(async (o) => {
      const raw = await window.__rawShard(o.shard, o.enc);
      try {
        await window['__w_fixed'].call({ cmd: 'queryCloseBuffer', buffer: raw,
          sql: o.sql, countSql: 'DELETE FROM sentences', params: o.params });
        return null;
      } catch (e) { return String(e.message); }
    }, { shard: SHARD_0, enc: SHARD_0_ENC, sql: SQL_TEXT, params: PARAMS });
    expect(err, 'countSql bypassed the read-only guard').not.toBeNull();
    expect(err).toMatch(/non-read-only countSql/);
  });

  /* Codex HIGH, 2026-07-27. `assertReadOnlySql` is a prefix regex, and SQLite
     accepts `WITH x AS (...) DELETE ... RETURNING` — a WRITE that begins with
     WITH. searchSentencesChunked (js/db.js) hands queryCloseBuffer arbitrary
     SQL, so the path was real. The fix is not a better regex (nested CTEs,
     comments, string literals full of keywords: a race against the grammar we
     lose); it is `PRAGMA query_only = 1` on the handle, which makes the ENGINE
     refuse every write regardless of SQL shape. */
  const WITH_DELETE =
    'WITH doomed AS (SELECT rowid AS r FROM sentences LIMIT 5) ' +
    'DELETE FROM sentences WHERE rowid IN (SELECT r FROM doomed) RETURNING rowid';
  const WITH_UPDATE =
    "WITH t AS (SELECT rowid AS r FROM sentences LIMIT 1) " +
    "UPDATE sentences SET sentence = 'x' WHERE rowid IN (SELECT r FROM t)";
  const WITH_INSERT =
    'WITH src AS (SELECT 1 AS a) INSERT INTO sentences ' +
    "(nr,seq,ts,ts_end,sentence,sentence_search) SELECT a,a,'','','x','x' FROM src";

  test('a WITH-prefixed write is refused by the engine and leaves the buffer intact',
    async ({ page }) => {
      await openHarness(page);

      const out = await page.evaluate(async (o) => {
        const results = {};
        for (const [name, sql] of Object.entries(o.writes)) {
          const raw = await window.__rawShard(o.shard, o.enc);
          results[name] = await window['__w_fixed'].call({ cmd: '__writeProbe', buffer: raw, sql });
        }
        return results;
      }, { shard: SHARD_0, enc: SHARD_0_ENC, writes: { WITH_DELETE, WITH_UPDATE, WITH_INSERT } });

      for (const [name, r] of Object.entries(out)) {
        expect(r.err, `${name} was NOT refused — a write reached a zero-copy shard`)
          .not.toBeNull();
        // Either sieve or engine may speak first; both are acceptable, silence is not.
        expect(r.err).toMatch(/refuses a non-read-only|readonly database/);
        expect(r.changed,
          `${name} mutated the caller's buffer at offset ${r.at}`).toBe(false);
      }
    });

  test('NEGATIVE CONTROL: with both guards removed, that same write DOES corrupt the buffer',
    async ({ page }) => {
      await openHarness(page);

      const out = await page.evaluate(async (o) => {
        const raw = await window.__rawShard(o.shard, o.enc);
        return await window['__w_unguarded'].call({ cmd: '__writeProbe', buffer: raw, sql: o.sql });
      }, { shard: SHARD_0, enc: SHARD_0_ENC, sql: WITH_DELETE });

      // This is the whole argument for the guard: strip it and the write goes
      // through the alias into memory the caller still owns.
      expect(out.err,
        'the unguarded worker refused the write too — then the guard above ' +
        'proves nothing, and this control must be re-derived').toBeNull();
      expect(out.changed,
        "the unguarded write did NOT change the caller's buffer — the " +
        'corruption premise behind PRAGMA query_only is wrong and the whole ' +
        'zero-copy design needs re-examining').toBe(true);
      expect(out.at).toBeGreaterThanOrEqual(0);
    });

  test('the spec measures the SAME worker file production loads (cache-bust drift)',
    async ({ page }) => {
      /* Codex MEDIUM, 2026-07-27: this file used to fetch a bare
         '/js/db-worker.js' while the app and the service worker load
         'js/db-worker.js?v=<hash>'. Every test here could stay green while the
         artefact users actually run was a different, stale file. */
      const info = await openHarness(page);
      expect(info.workerUrl,
        'the worker URL is not cache-busted — db.js should load ?v=<hash>')
        .toMatch(/db-worker\.js\?v=[0-9a-f]{8}$/);
    });

  test('the shadow has not been carried into any other function in db-worker.js',
    async ({ request }) => {
      /* The one hole a runtime test cannot cover: copying this trick into
         openGz / openBuffer, where the handle is parked in `databases` and
         OUTLIVES the caller's buffer — a use-after-free that would surface as
         corrupt rows much later, in a different feature. Source-level is the
         only level at which "do not paste this elsewhere" is checkable. */
      const src = await (await request.get('/js/db-worker.js')).text();

      // Every `X.slice = function` assignment in the file...
      const assignments = [...src.matchAll(/^[ \t]*(\w+)\.slice\s*=\s*function/gm)];
      expect(assignments.length,
        'more than one .slice shadow in db-worker.js — the shard trick has been ' +
        'copied somewhere else; see the LIMIT note in queryCloseBuffer')
        .toBe(1);

      // ...must sit inside queryCloseBuffer and nowhere else.
      const fnStart = src.indexOf('function queryCloseBuffer(');
      expect(fnStart, 'queryCloseBuffer not found').toBeGreaterThan(-1);
      const fnEnd = src.indexOf('\n}', fnStart);
      const idx = assignments[0].index;
      expect(idx > fnStart && idx < fnEnd,
        'the .slice shadow moved out of queryCloseBuffer').toBe(true);

      // And the callers that keep their handle must still open the plain way.
      for (const fn of ['openGz', 'openBuffer']) {
        const s = src.indexOf('function ' + fn + '(');
        expect(s, fn + ' not found').toBeGreaterThan(-1);
        const body = src.slice(s, src.indexOf('\n}', s));
        expect(body,
          fn + ' now shadows .slice — it parks the handle in `databases`, so ' +
          'the buffer would be freed while MEMFS still points at it')
          .not.toMatch(/\.slice\s*=/);
      }
    });
});
