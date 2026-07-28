// @ts-check
// Staging-side cache-bust drift gate (2026-07-28).
//
// Incident this closes: three staging commits (2ebc26b, d13be0a, 2787bb9,
// 2026-07-27) changed js/ files without anyone re-running
// scripts/cache_bust.py. sw-precache.js kept SHELL_VERSION '7ffc8197c5b1' —
// the hash of an EARLIER commit (63a9574) — so a device on that shell cache
// never fetched any of the three commits' fixes. That staleness is what made
// the field investigation into the addShards() re-download bug (see
// pwa.spec.js "addShards() skips shards already correct in IndexedDB")
// confusing for a while: the device under test was three commits behind its
// own repo, and nobody could tell from the source tree alone.
//
// promote_to_deploy.py's ensure_cache_bust() already catches this drift, but
// only at the DEPLOY step (staging -> deploy) — by then the staging repo
// itself has already carried the mismatch for however long. Nothing caught
// it on the staging side, where the drift is actually introduced (a commit
// that touches js/ without running cache_bust.py). This file closes that gap
// as a Playwright test rather than a git hook: hooks are a principle file
// under this Pradesh's constitution and need Rājan's sign-off, whereas a
// test runs automatically on every `npx playwright test` the same as any
// other staging feature gate — no separate mechanism to remember exists.
//
// Both checks are read-only (build_sw_precache.py `check=True` / cache_bust.py
// `--check`): this file must never rewrite index.html or sw-precache.js.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const PY = process.platform === 'win32' ? 'python' : 'python3';

test.describe('Cache-bust drift gate (staging, 2026-07-28)', () => {

  test('B1. sw-precache.js SHELL_VERSION matches the current staging/ tree', async () => {
    const r = spawnSync(PY, ['scripts/build_sw_precache.py', '--check'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    // NEGATIVE CHECK RUN (verified 2026-07-28 against the tree AS FOUND:
    // js/downloader.js had just been edited for the addShards() fix above,
    // and cache_bust.py had genuinely not been re-run yet):
    //   Error: sw-precache.js is stale -- run `python scripts/cache_bust.py`
    //     Expected: 0
    //     Received: 1
    //   stdout included:
    //     "sw-precache.js: 53 files, 3.44 MB total, SHELL_VERSION=19a007754fef
    //      (STALE — cache_bust.py / build_sw_precache.py needs a run)"
    // This test only turned green again after running
    // `python scripts/cache_bust.py` for real (which also rewrote
    // sw-precache.js's SHELL_VERSION and PRECACHE hashes to match).
    expect(
      r.status,
      'sw-precache.js is stale -- run `python scripts/cache_bust.py` before committing:\n' +
        (r.stdout || r.stderr || '')
    ).toBe(0);
  });

  test('B2. index.html <script>/<link> ?v= hashes match the referenced files\' content', async () => {
    const r = spawnSync(PY, ['scripts/cache_bust.py', '--check'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(r.status, 'cache_bust.py --check itself failed to run:\n' + (r.stdout || r.stderr || '')).toBe(0);

    // cache_bust.py --check's own process exit code is ALWAYS 0 (main() never
    // sys.exit()s in dry-run mode) — it is a reporting tool, not a gate. The
    // gate is the same line-shape promote_to_deploy.py's ensure_cache_bust()
    // parses out of a real (non---check) run: cache_bust() prints one line
    // per target, "path → ?v=hash" when the file's current-content hash
    // differs from what index.html already has, plus "(unchanged)" appended
    // when it does not. A stale reference is a line with the first but not
    // the second.
    const stale = (r.stdout || '')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.includes('→ ?v=') && !l.includes('(unchanged)'));

    // NEGATIVE CHECK RUN (same tree as B1, before the real cache_bust.py run):
    //   Error: index.html references a stale ?v= hash...
    //     Expected: []
    //     Received: ["js/downloader.js → ?v=7151e588"]
    expect(
      stale,
      'index.html references a stale ?v= hash -- run `python scripts/cache_bust.py` before committing:\n' +
        (r.stdout || '')
    ).toEqual([]);
  });

  test('B3. Changing a shell file changes sw.js\'s OWN bytes, not just the imported sw-precache.js (Codex HIGH-2, 2026-07-28)', async () => {
    // build_sw_precache.py checks sw-precache.js content, but the browser's SW
    // update check never looks inside anything sw.js imports — only at sw.js's
    // OWN bytes (the file js/app.js registers). B1/B2 alone would go green
    // while shipping a shell change that no installed browser ever re-checks
    // for. This test proves the actual mechanism (a real shell-file change,
    // a real cache_bust.py run, a real byte comparison of sw.js before/after)
    // rather than asserting on sw.js's source text.
    //
    // A throwaway probe file is used instead of editing a real js/ file:
    // build_sw_precache.py's collect() globs `staging/js/*.js` automatically,
    // so dropping a new file there is picked up by the SAME shell scan real
    // edits go through, with no risk to tracked source. Removed + the whole
    // tree regenerated again in `finally`, so nothing but the probe's
    // disappearance is left uncommitted.
    const swPath = path.join(REPO_ROOT, 'staging', 'sw.js');
    const probePath = path.join(REPO_ROOT, 'staging', 'js', '__cachebust_gate_probe.js');
    const before = fs.readFileSync(swPath);

    try {
      fs.writeFileSync(probePath, '// cache-bust gate probe file — ' + Date.now() + '\n');

      const run = spawnSync(PY, ['scripts/cache_bust.py'], { cwd: REPO_ROOT, encoding: 'utf8' });
      expect(run.status, 'cache_bust.py failed to run:\n' + (run.stdout || run.stderr || '')).toBe(0);

      const after = fs.readFileSync(swPath);

      // NEGATIVE CHECK RUN (verified 2026-07-28, sw.js reverted to the
      // pre-fix version — SW_SHELL_STAMP removed, only self.SHELL_VERSION
      // from the imported sw-precache.js): adding the probe file still
      // changed SHELL_VERSION (confirmed via build_sw_precache.py --check
      // output), but sw.js's own bytes were BYTE-IDENTICAL before and after:
      //   Error: sw.js bytes did not change when a shell file changed
      //     Expected: true
      //     Received: false
      // i.e. exactly the bug HIGH-2 describes — a real shell change that a
      // browser already holding the old sw.js would never notice.
      expect(
        Buffer.compare(before, after) !== 0,
        'sw.js bytes did not change when a shell file changed -- an installed browser would never re-check for a new worker'
      ).toBe(true);
    } finally {
      fs.rmSync(probePath, { force: true });
      // Regenerate once more so the probe's removal is reflected everywhere
      // (sw-precache.js / sw.js / index.html back to matching the real tree)
      // — leaves nothing but the probe file's disappearance uncommitted.
      spawnSync(PY, ['scripts/cache_bust.py'], { cwd: REPO_ROOT, encoding: 'utf8' });
    }
  });
});
