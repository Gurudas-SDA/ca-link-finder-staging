// @ts-check
// PWA offline-library test suite (supersedes the temporary smoke-offline.spec.js).
//
// Covers the full offline feature: first-install UX (confirmation prompt,
// progress, install click-guard), instant second visits with zero data
// network, full offline operation behind the service worker (shell from
// ca-shell cache, data from IndexedDB, requiresInternet guard on external
// links), delta updates (manifest diff -> download -> sha256 verify -> apply
// -> update note), resumable installs across page reloads, and the legacy
// network fallback for browsers without DecompressionStream.
//
// Readiness signal: the placeholder-based waitForAppReady from app.spec.js is
// a false positive on repeat visits (count comes instantly from the cached
// ppp_total_lectures) — the offline layer's own PPP.offlineStatus.dataReady
// flag is the reliable signal and is used throughout this file.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

// Real manifest from disk — used to build the delta fixture and to pick
// concrete packs for the resume scenario (never hardcode pack ids: the
// manifest regenerates with every DB build).
const MANIFEST_PATH = path.join(__dirname, '..', 'data', 'manifest.json');
const realManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

// Full install over localhost takes ~7-10 s; give every test generous room.
test.setTimeout(120000);

// ===== helpers =====

/** Auto-start the REAL install flow without the confirmation click. */
function addAutoInstallHook(page) {
  return page.addInitScript(() => {
    try { localStorage.setItem('ppp_auto_install', '1'); } catch (e) {}
  });
}

/**
 * Reliable readiness: the offline layer sets PPP.offlineStatus.dataReady
 * when the app is fully open from IndexedDB (both after a fresh install and
 * on repeat visits).
 */
async function waitForDataReady(page, timeout = 110000) {
  await page.waitForFunction(
    () => window.PPP && PPP.offlineStatus && PPP.offlineStatus.dataReady === true,
    { timeout }
  );
}

/** Run a metadata search and assert it returns > 0 results. */
async function expectSearchWorks(page, term = 'tattva') {
  await page.fill('#searchTerm', term);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#resultsInfo strong', { timeout: 10000 });
  const info = await page.locator('#resultsInfo strong').textContent();
  expect(parseInt(info)).toBeGreaterThan(0);
}

/**
 * Node-side poll for the background install committing localManifest to IDB
 * (startBackgroundInstall does NOT flip the running session to IDB — a
 * reload is required for that; see loadData()/openFromIdb() in app.js).
 * Deliberately polled from Node rather than via page.waitForFunction with an
 * async predicate: an un-awaited Promise returned each poll is truthy and
 * ends the wait vacuously (see the identical note on the SW-cache poll in
 * P3 below and the install-state poll in P5).
 */
async function waitForLocalManifestSet(page, timeout = 120000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const has = await page.evaluate(async () => {
      if (!(window.PPP && PPP.offlineStore)) return false;
      const m = await PPP.offlineStore.getState('localManifest');
      return !!m;
    });
    if (has) return;
    if (Date.now() > deadline) throw new Error('Timed out waiting for background install to commit localManifest');
    await page.waitForTimeout(500);
  }
}

/**
 * From the installed IndexedDB library pick one premium EN transcript nr and
 * one raw-ONLY nr (raw:en:{nr} with no t:en:{nr} counterpart).
 */
async function findIdbTranscriptNrs(page) {
  const nrs = await page.evaluate(async () => {
    const idb = await PPP.offlineStore.open();
    const keys = await new Promise((resolve, reject) => {
      const tx = idb.transaction('files', 'readonly');
      const req = tx.objectStore('files').getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const premKeys = keys.filter(k => String(k).startsWith('t:en:'));
    const premSet = new Set(premKeys.map(k => String(k).slice(5)));
    const rawOnly = keys
      .filter(k => String(k).startsWith('raw:en:'))
      .map(k => String(k).slice(7))
      .find(nr => !premSet.has(nr));
    return {
      totalFiles: keys.length,
      premNr: premKeys.length ? String(premKeys[0]).slice(5) : null,
      rawOnlyNr: rawOnly || null,
    };
  });
  expect(nrs.totalFiles).toBeGreaterThan(10000);
  expect(nrs.premNr).toBeTruthy();
  expect(nrs.rawOnlyNr).toBeTruthy();
  return nrs;
}

test.describe('PWA offline library', () => {

  test('P1. Online-first UX: app usable immediately, optional "Work offline" button, background download does not block', async ({ page }) => {
    // NO ppp_auto_install hook — the real first-visit online-first UX: no
    // forced/blocking install screen, the app itself is the base experience.
    await page.goto('./');

    // (a) App is usable online right away — not stuck on a "Loading"/
    // "Required" screen, and a real search returns results immediately.
    const searchInput = page.locator('#searchTerm');
    await expect(searchInput).toBeVisible({ timeout: 20000 });
    await expect(searchInput).toBeEnabled({ timeout: 20000 });
    // The input is enabled immediately (clearComboDisplay()) with a transient
    // "Loading the database…" placeholder until onDataLoaded() swaps in the
    // real count text — assert with auto-retry, not a one-shot read, so this
    // doesn't race the transient state.
    await expect(searchInput).not.toHaveAttribute('placeholder', /Loading|Required/i, { timeout: 20000 });
    await expectSearchWorks(page);

    // (b) The optional offline install is a small "Work offline" button next
    // to "How to use search?" — NOT a big banner, and it only appears once
    // the online DB is ready (non-blocking — no #installOfflineBtn forced
    // flow, and no #offlineOffer banner popping up while still loading).
    await expect(page.locator('#installOfflineBtn')).toHaveCount(0);
    await expect(page.locator('#offlineOffer')).toHaveCount(0);
    const workBtn = page.locator('#offlineWorkBtn');
    await expect(workBtn).toBeVisible({ timeout: 20000 });

    // Click reveals the info panel (size/time text + Download button).
    const infoPanel = page.locator('#offlineInfoPanel');
    await expect(infoPanel).toBeHidden();
    await workBtn.click();
    await expect(infoPanel).toBeVisible();
    const offerBtn = infoPanel.locator('#offlineOfferBtn');
    await expect(offerBtn).toBeVisible();
    await expect(offerBtn).toHaveText('Download');

    // (c) Click starts startBackgroundInstall(): #offlineProgress switches to
    // a live progress message (MB counter / i18n offlineDownloading), and the
    // app stays fully interactive throughout — no click-guard, no toast, no
    // disabled input. (Don't wait for the full ~196 MB download to finish —
    // only that progress genuinely starts without blocking the UI.)
    await offerBtn.click();
    await page.waitForFunction(() => {
      const m = document.getElementById('offlineProgressMsg');
      return !!m && /MB/.test(m.textContent || '');
    }, { timeout: 20000 });

    // Closing the info panel mid-download does not hide the progress row —
    // it lives in a separate element (#offlineProgress).
    await infoPanel.locator('button[aria-label="Close"]').click();
    await expect(infoPanel).toBeHidden();
    await expect(page.locator('#offlineProgress')).toBeVisible();

    await expect(searchInput).toBeEnabled();
    await searchInput.fill('krishna');
    await expect(searchInput).toHaveValue('krishna');
    await expectSearchWorks(page, 'krishna');
  });

  test('P1b. Installed state: #offlineWorkBtn stays visible with ✓ label, panel shows installed text, dismiss keeps the button', async ({ page }) => {
    // REAL install (auto hook) — loadDataLegacy runs first (offer state),
    // then the background install commits localManifest.
    await addAutoInstallHook(page);
    await page.goto('./');
    await waitForLocalManifestSet(page);

    const workBtn = page.locator('#offlineWorkBtn');

    // (a) Install finished THIS session -> button flips to the ✓ state
    // without a reload (startBackgroundInstall completion hook).
    await expect(workBtn).toBeVisible({ timeout: 20000 });
    await expect(workBtn).toHaveText(/✓/, { timeout: 20000 });

    // (b) Reload — the openFromIdb (installed) path must ALSO show the ✓
    // button (the old bug: it never called maybeShowOfflineWorkButton).
    await page.reload();
    await waitForDataReady(page);
    await expect(workBtn).toBeVisible({ timeout: 20000 });
    await expect(workBtn).toHaveText(/✓/);

    // (c) Click opens the SAME info panel in its installed variant: the
    // offlineReadyText status message, NO Download button.
    const infoPanel = page.locator('#offlineInfoPanel');
    await expect(infoPanel).toBeHidden();
    await workBtn.click();
    await expect(infoPanel).toBeVisible();
    await expect(infoPanel).toContainText('offline library is downloaded');
    await expect(infoPanel.locator('#offlineOfferBtn')).toHaveCount(0);

    // (d) Dismiss only closes the panel — the ✓ status button stays visible.
    await infoPanel.locator('button[aria-label="Close"]').click();
    await expect(infoPanel).toBeHidden();
    await expect(workBtn).toBeVisible();
  });

  test('P3. Full offline with SW: shell from cache, data from IDB, requiresInternet guard', async ({ page, context }) => {
    await addAutoInstallHook(page);
    await page.goto('./');

    // Online-first: the app is usable immediately (legacy/online load), and
    // ppp_auto_install=1 makes loadData() call startBackgroundInstall()
    // instead of showing the offer banner. That call downloads into IDB
    // WITHOUT switching the running session over (see loadData() in
    // app.js) — dataReady only flips true after a reload re-opens from IDB.
    await expect(page.locator('#searchTerm')).toBeEnabled({ timeout: 20000 });
    await waitForLocalManifestSet(page, 110000);

    await page.reload();
    await waitForDataReady(page);

    // Wait for the service worker to be active AND the ca-shell precache to
    // be populated (precache runs inside the install event, so an active
    // worker implies a complete cache — verify index.html is really there).
    // NOTE: waitForFunction must NOT get an async predicate — the pending
    // Promise it returns each poll is truthy, ending the wait vacuously.
    // Poll from Node instead.
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    const cacheDeadline = Date.now() + 60000;
    let shellCached = false;
    while (Date.now() < cacheDeadline && !shellCached) {
      shellCached = await page.evaluate(async () => {
        const names = await caches.keys();
        const shell = names.find(n => n.indexOf('ca-shell-') === 0);
        if (!shell) return false;
        const cache = await caches.open(shell);
        const keys = await cache.keys();
        if (keys.length < 10) return false;
        const idx = await cache.match(new URL('index.html', location.href).toString(), { ignoreSearch: true });
        return !!idx;
      });
      if (!shellCached) await page.waitForTimeout(500);
    }
    expect(shellCached).toBe(true);

    // Go fully offline and reload: the shell must come from the SW cache and
    // the data from IndexedDB.
    await context.setOffline(true);
    try {
      await page.reload();
      await expect(page).toHaveTitle(/Chaitanya Academy/);
      await waitForDataReady(page, 30000);

      // Search works offline.
      await expectSearchWorks(page, 'krishna');

      // Premium transcript is served from IDB (no network available at all).
      const nrs = await findIdbTranscriptNrs(page);
      await page.evaluate((nr) => PPP.app.openHtmlTranscriptViewer(nr, 'en'), nrs.premNr);
      await page.waitForFunction(() => {
        const body = document.getElementById('transcriptModalBody');
        return body && body.textContent && body.textContent.length > 200;
      }, { timeout: 15000 });
      const premTitle = await page.locator('#transcriptModalTitle').textContent();
      expect(premTitle).not.toContain('[Raw]');
      expect(premTitle).not.toContain('not found');
      await page.keyboard.press('Escape');

      // Raw-only lecture renders with the [Raw] marker and non-empty body.
      await page.evaluate((nr) => PPP.app.openHtmlTranscriptViewer(nr, 'en'), nrs.rawOnlyNr);
      await page.waitForFunction(() => {
        const t = document.getElementById('transcriptModalTitle');
        return t && t.textContent && t.textContent.indexOf('[Raw]') === 0;
      }, { timeout: 15000 });
      const rawLen = await page.evaluate(() =>
        document.getElementById('transcriptModalBody').textContent.length);
      expect(rawLen).toBeGreaterThan(100);
      await page.keyboard.press('Escape');

      // External MP3/Drive/YouTube chip: offline click is intercepted and
      // answers with the requiresInternet toast instead of navigating.
      await page.waitForSelector('a.ext-chip', { timeout: 10000 });
      const mp3Chip = page.locator('a.ext-chip', { hasText: 'Mp3' });
      const chip = (await mp3Chip.count()) > 0 ? mp3Chip.first() : page.locator('a.ext-chip').first();
      await chip.click({ force: true });
      await expect(page.locator('#uiToast')).toContainText('Requires an internet connection', { timeout: 5000 });
    } finally {
      await context.setOffline(false);
    }
  });

  // Service-worker-free block: page.route must deterministically see every
  // request (same technique as app.spec.js test 30) for the network-abort,
  // delta-fixture, resume and legacy scenarios.
  test.describe('deterministic network (SW blocked)', () => {
    test.use({ serviceWorkers: 'block' });

    test('P2. Second visit instant with ZERO data network', async ({ page, context }) => {
      await addAutoInstallHook(page);
      await page.goto('./');
      // startBackgroundInstall() (online-first UX) downloads into IDB without
      // switching this session over — reload once install commits, same as P3.
      await waitForLocalManifestSet(page, 110000);
      await page.reload();
      await waitForDataReady(page);

      // New page in the SAME context (same IndexedDB): block every data
      // file, pack and transcript — only manifest.json (delta check) and
      // shell assets may pass.
      const page2 = await context.newPage();
      const dataRequests = [];
      page2.on('request', req => {
        if (/\/(packs\/|transcripts\/|data\/ppp_)/.test(req.url())) dataRequests.push(req.url());
      });
      await page2.route(/\/(packs\/|transcripts\/|data\/ppp_)/, route => route.abort());

      const t0 = Date.now();
      await page2.goto('./');
      await waitForDataReady(page2, 30000);
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(15000); // instant open from IDB, no re-download

      await expectSearchWorks(page2);

      // Summaries/essence available: extras cache filled from core:extras in
      // IDB (network extras are blocked above, so IDB is the only source).
      await page2.waitForFunction(() => window.PPP && PPP.ui && PPP.ui.extrasReady(), { timeout: 30000 });

      // Not a single data/pack/transcript request went to the network.
      expect(dataRequests).toEqual([]);
      await page2.close();
    });

    test('P4. Delta update: manifest diff -> download -> sha256 verify -> apply -> note', async ({ page, context }) => {
      await addAutoInstallHook(page);
      await page.goto('./');
      // startBackgroundInstall() (online-first UX) downloads into IDB without
      // switching this session over — reload once install commits, same as P3.
      await waitForLocalManifestSet(page, 110000);
      await page.reload();
      await waitForDataReady(page);

      // Build the fixture: a tiny valid gzip JSON replacing core:extras, with
      // REAL size + sha256 computed here, and a manifest whose extras entry
      // points at it. This exercises the entire delta path end-to-end.
      const fixtureObj = { '455': { essence: 'PWA-DELTA-FIXTURE' } };
      const fixtureJson = JSON.stringify(fixtureObj);
      const fixtureGz = zlib.gzipSync(Buffer.from(fixtureJson, 'utf8'));
      const fixtureSha = crypto.createHash('sha256').update(fixtureGz).digest('hex');
      const mutated = JSON.parse(JSON.stringify(realManifest));
      mutated.generated = '2099-01-01 00:00:00';
      mutated.core.extras = {
        path: realManifest.core.extras.path,
        hash: fixtureSha.slice(0, 10),
        sha256: fixtureSha,
        size: fixtureGz.length,
        raw: Buffer.byteLength(fixtureJson, 'utf8'),
      };

      const page2 = await context.newPage();
      await page2.route('**/data/manifest.json*', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mutated),
      }));
      await page2.route('**/data/ppp_lecture_extras.json.gz*', route => route.fulfill({
        status: 200,
        contentType: 'application/gzip',
        body: fixtureGz,
      }));

      await page2.goto('./');
      await waitForDataReady(page2, 30000);

      // updatedItems note appears (extras = 1 changed item; auto-hides in 6 s).
      await page2.waitForSelector('#updateNoteInfo', { state: 'visible', timeout: 30000 });
      await expect(page2.locator('#updateNoteInfo')).toHaveText('Updated: 1 items');

      // The fence advanced: localManifest in IDB is now the mutated manifest,
      // and core:extras decompresses to EXACTLY the fixture content.
      const after = await page2.evaluate(async () => {
        const local = await PPP.offlineStore.getState('localManifest');
        const extrasText = await PPP.offlineStore.getText('core:extras');
        return { hash: local.core.extras.hash, generated: local.generated, extrasText };
      });
      expect(after.hash).toBe(mutated.core.extras.hash);
      expect(after.generated).toBe('2099-01-01 00:00:00');
      expect(after.extrasText).toBe(fixtureJson);

      // The running app reloaded the extras cache from the fresh IDB copy.
      await page2.waitForFunction(() => window.PPP && PPP.ui && PPP.ui.extrasReady(), { timeout: 30000 });
      const essence = await page2.evaluate(() => {
        const e = PPP.ui.getExtras ? PPP.ui.getExtras('455') : null;
        return e && e.essence;
      });
      if (essence !== null && essence !== undefined) {
        expect(essence).toBe('PWA-DELTA-FIXTURE');
      }
      await page2.close();
    });

    test('P5. Resume: interrupted install continues without re-downloading finished packs', async ({ page, context }) => {
      test.setTimeout(240000);

      // Persistently block ONE (the smallest) pack on the first page; every
      // other item completes and its durable resume state lands in IDB.
      const packsBySize = realManifest.packs.slice().sort((a, b) => a.size - b.size);
      const blockedPack = packsBySize[0];
      const expectedDonePacks = realManifest.packs.length - 1;

      await addAutoInstallHook(page);
      await page.route('**/' + blockedPack.path + '*', route => route.abort());
      await page.goto('./');

      // Wait until everything EXCEPT the blocked pack is durably completed
      // (the failed item makes firstInstall reject for this session, but the
      // surviving pool runner keeps finishing the remaining items and the
      // install state snapshots commit atomically with each item).
      // (Node-side poll — see the async-predicate note in P3.)
      const deadline = Date.now() + 180000;
      let installState = null;
      for (;;) {
        installState = await page.evaluate(async () => {
          if (!(window.PPP && PPP.offlineStore)) return null;
          return PPP.offlineStore.getState('install').catch(() => null);
        });
        if (installState &&
            Object.keys(installState.completedCore || {}).length === 2 &&
            Object.keys(installState.completedPacks || {}).length >= expectedDonePacks) break;
        if (Date.now() > deadline) break;
        await page.waitForTimeout(500);
      }
      expect(installState).not.toBeNull();
      expect(Object.keys(installState.completedCore || {}).length).toBe(2);
      expect(Object.keys(installState.completedPacks || {}).length)
        .toBeGreaterThanOrEqual(expectedDonePacks);

      // Sanity: the install did NOT complete (blocked pack missing, no manifest).
      const midState = await page.evaluate(async () => ({
        localManifest: !!(await PPP.offlineStore.getState('localManifest')),
        install: await PPP.offlineStore.getState('install'),
      }));
      expect(midState.localManifest).toBe(false);
      expect(midState.install.completedPacks[blockedPack.id]).toBeUndefined();

      // "Reload": close the page, open a new one WITHOUT the abort route.
      await page.close();
      const page2 = await context.newPage();
      // Online-first UX: WITHOUT the auto-install hook a fresh (uninstalled)
      // page would just show the optional #offlineWorkBtn button instead of
      // resuming the interrupted install automatically.
      await addAutoInstallHook(page2);
      const packRequests = [];
      page2.on('request', req => {
        if (req.url().includes('/packs/')) packRequests.push(req.url());
      });

      await page2.goto('./');
      await waitForLocalManifestSet(page2, 60000);
      await page2.reload();
      await waitForDataReady(page2, 60000);
      const done = await page2.evaluate(async () => ({
        localManifest: !!(await PPP.offlineStore.getState('localManifest')),
        install: await PPP.offlineStore.getState('install'),
      }));
      expect(done.localManifest).toBe(true);   // install completed
      expect(done.install).toBeNull();         // resume state cleaned up

      // Progress did NOT restart: the ONLY pack fetched on the second page is
      // the previously blocked one — zero requests for any completed pack.
      expect(packRequests.length).toBeGreaterThanOrEqual(1);
      for (const url of packRequests) {
        expect(url).toContain(blockedPack.id);
      }

      await expectSearchWorks(page2);
      await page2.close();
    });

    test('P6. Legacy fallback: no DecompressionStream -> network SQLite path, no install prompt', async ({ page }) => {
      // Simulate an old browser: offlineStore.supported() must return false.
      await page.addInitScript(() => {
        try { delete window.DecompressionStream; } catch (e) {}
        try { Object.defineProperty(window, 'DecompressionStream', { value: undefined }); } catch (e) {}
      });

      const metaRequest = page.waitForRequest('**/data/ppp_meta.db*', { timeout: 60000 });
      await page.goto('./');

      // Legacy path really hits the network for the meta DB.
      await metaRequest;

      // Legacy readiness: placeholder unlocks with the lecture count (valid on
      // a first visit — no cached count in this fresh context).
      await page.waitForFunction(() => {
        const input = document.getElementById('searchTerm');
        return input && !input.disabled && input.placeholder && input.placeholder.includes('9');
      }, { timeout: 90000 });

      // No offline install prompt and no offline status — pure legacy mode.
      await expect(page.locator('#installOfflineBtn')).toHaveCount(0);
      const offlineStatus = await page.evaluate(() => window.PPP && PPP.offlineStatus);
      expect(offlineStatus).toBeFalsy();

      await expectSearchWorks(page);
    });
  });

});

// ===========================================================================
// Phase A — offline language selection (EN mandatory base; LV/RU opt-in).
// The install lets the user choose which transcript languages to pre-download;
// unselected LV/RU still open on demand online via the same-origin
// transcripts/<lang>/<nr>.html fetch. These tests cover the picker UI,
// selection-aware size + work-list filtering, delta filtering, and the online
// open / graceful-offline behaviour for a non-downloaded language.
// ===========================================================================

/** LV transcript nr known-in-meta, used with a mocked fetch (see PL4) so the
 *  test needs no real transcripts/lv/*.html file on disk — that directory is
 *  gitignored (local-only, 246 MB) and absent in CI checkouts. */
const LV_NR = '10011';

/** Install the EN-only base (LV/RU unchecked) via the auto/CI hooks, then
 *  reload so the running session opens from IndexedDB. */
async function installEnOnly(page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('ppp_auto_install', '1');
      localStorage.setItem('ppp_install_langs', '[]'); // EN base only
    } catch (e) {}
  });
  await page.goto('./');
  await waitForLocalManifestSet(page, 110000);
  await page.reload();
  await waitForDataReady(page);
}

test.describe('PWA offline language selection (Phase A)', () => {
  test.setTimeout(180000);

  test('PL1. Install prompt shows 3 language checkboxes; EN checked+disabled; size grows with selection', async ({ page }) => {
    await page.goto('./');
    await page.waitForFunction(() => window.PPP && PPP.app && PPP.downloader && PPP.offlineStore && PPP.offlineStore.supported());

    // Drive the first-install confirmation prompt directly.
    await page.evaluate(() => PPP.app.startFirstInstallFlow());
    await page.waitForSelector('#installLangSelect input[data-lang="en"]', { timeout: 20000 });

    const boxes = await page.$$eval('#installLangSelect input[data-lang]', els =>
      els.map(e => ({ lang: e.getAttribute('data-lang'), checked: e.checked, disabled: e.disabled })));
    expect(boxes.map(b => b.lang).sort()).toEqual(['en', 'lv', 'ru']);
    const en = boxes.find(b => b.lang === 'en');
    expect(en.checked).toBe(true);
    expect(en.disabled).toBe(true);
    expect(boxes.find(b => b.lang === 'lv').checked).toBe(false);
    expect(boxes.find(b => b.lang === 'ru').checked).toBe(false);

    // Option B default: the sentence shards (offline text search) are OPT-IN,
    // so the DEFAULT base (EN, shards unchecked) is ≈ 151 MB (meta+extras+EN
    // packs; the shards and the old single core:sentences DB add nothing).
    const baseTxt = await page.textContent('#installLangSelect .offline-lang-size');
    const baseMB = parseInt(String(baseTxt).replace(/[^0-9]/g, ''), 10);
    expect(baseMB).toBeGreaterThan(130);
    expect(baseMB).toBeLessThan(160);

    // The opt-in "Offline text search" shard checkbox exists and is UNCHECKED
    // by default. Ticking it makes the estimate jump by ~200 MB to ≈ 342 MB
    // (EN base + 21 sentence shards).
    const shardBox = page.locator('#installLangSelect input[data-shard]');
    await expect(shardBox).toHaveCount(1);
    expect(await shardBox.isChecked()).toBe(false);
    await shardBox.check();
    const shardTxt = await page.textContent('#installLangSelect .offline-lang-size');
    const shardMB = parseInt(String(shardTxt).replace(/[^0-9]/g, ''), 10);
    expect(shardMB).toBeGreaterThan(320);
    expect(shardMB).toBeLessThan(360);
    await shardBox.uncheck();   // isolate the language-only growth below

    // Tick LV + RU (shards still off) → displayed size grows to ≈ 177 MB
    // (EN base + prem-lv + prem-ru packs; EXCLUDES the dead core:sentences,
    // so this no longer equals manifest.totals.bytes, which still includes
    // that dead core and reports ≈ 195 MB).
    await page.check('#installLangSelect input[data-lang="lv"]');
    await page.check('#installLangSelect input[data-lang="ru"]');
    const fullTxt = await page.textContent('#installLangSelect .offline-lang-size');
    const fullMB = parseInt(String(fullTxt).replace(/[^0-9]/g, ''), 10);
    expect(fullMB).toBeGreaterThan(baseMB);
    expect(fullMB).toBeGreaterThan(170);
    expect(fullMB).toBeLessThan(210);
  });

  test.describe('deterministic network (SW blocked)', () => {
    test.use({ serviceWorkers: 'block' });

    test('PL2. EN-only install skips prem-lv/prem-ru packs and persists langs=[]', async ({ page }) => {
      await page.addInitScript(() => {
        try {
          localStorage.setItem('ppp_auto_install', '1');
          localStorage.setItem('ppp_install_langs', '[]');
        } catch (e) {}
      });
      const packReqs = [];
      page.on('request', req => { if (req.url().includes('/packs/')) packReqs.push(req.url()); });

      await page.goto('./');
      await waitForLocalManifestSet(page, 110000);

      // Not a single LV/RU pack was requested; EN packs were.
      const lvru = packReqs.filter(u => /prem-lv|prem-ru|raw-lv|raw-ru/.test(u));
      expect(lvru).toEqual([]);
      expect(packReqs.some(u => /prem-en|raw-en/.test(u))).toBe(true);

      // Persisted selection is the EN-only base.
      const langs = await page.evaluate(() => PPP.offlineStore.getState('langs'));
      expect(langs).toEqual([]);
    });

    test('PL3. Delta update with EN-only selection never requests LV/RU packs', async ({ page, context }) => {
      await installEnOnly(page);

      // Mutate a LV pack hash — a "change" that MUST be ignored because LV is
      // not in the selection.
      const mutated = JSON.parse(JSON.stringify(realManifest));
      mutated.generated = '2099-02-02 00:00:00';
      const lvPack = mutated.packs.find(p => p.lang === 'lv');
      lvPack.hash = 'deadbeef01';
      lvPack.sha256 = 'f'.repeat(64);

      const page2 = await context.newPage();
      const packReqs = [];
      page2.on('request', req => { if (req.url().includes('/packs/')) packReqs.push(req.url()); });
      await page2.route('**/data/manifest.json*', route => route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(mutated),
      }));

      await page2.goto('./');
      await waitForDataReady(page2, 30000);
      // Give the background delta check time to run and (correctly) do nothing.
      await page2.waitForTimeout(2500);

      const lvru = packReqs.filter(u => /prem-lv|prem-ru/.test(u));
      expect(lvru).toEqual([]);
      // No update note — the LV change is filtered out by the EN-only selection.
      await expect(page2.locator('#updateNoteInfo')).toBeHidden();
      await page2.close();
    });

    test('PL4. After EN-only install, an LV transcript opens online and shows a graceful message offline', async ({ page, context }) => {
      const lvNr = LV_NR;
      await installEnOnly(page);

      // (a) Online: LV is not in IDB, so the viewer fetches the same-origin
      // per-lecture HTML file. Mock that fetch (transcripts/ is gitignored and
      // absent in CI) and assert the request fires and content renders.
      const mockLvRoute = route => route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<div class="transcript-body">' + 'LV transcript content '.repeat(20) + '</div>',
      });
      await page.route('**/transcripts/lv/**', mockLvRoute);
      const lvReq = page.waitForRequest(u => u.url().includes('/transcripts/lv/' + lvNr + '.html'), { timeout: 15000 });
      await page.evaluate((nr) => PPP.app.openHtmlTranscriptViewer(nr, 'lv'), lvNr);
      await lvReq;
      await page.waitForFunction(() => {
        const b = document.getElementById('transcriptModalBody');
        return b && b.textContent && b.textContent.length > 100;
      }, { timeout: 15000 });
      await page.keyboard.press('Escape');

      // (b) Offline: remove the mock so the real fetch is attempted and fails
      // offline (no real file, no IDB entry) → the graceful "language not
      // downloaded" copy (not the raw requires-internet message).
      await page.unroute('**/transcripts/lv/**', mockLvRoute);
      await context.setOffline(true);
      try {
        await page.evaluate((nr) => PPP.app.openHtmlTranscriptViewer(nr, 'lv'), lvNr);
        await expect(page.locator('#transcriptModalBody')).toContainText('not downloaded', { timeout: 15000 });
      } finally {
        await context.setOffline(false);
      }
    });
  });
});
