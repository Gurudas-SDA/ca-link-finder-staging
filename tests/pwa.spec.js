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

// Skip the onboarding gate (language + purpose picker, added for the
// menu-search feature) on every test in this file, whether or not it also
// calls addAutoInstallHook() below — several PWA tests (e.g. P1) navigate
// with no init script of their own and would otherwise be stuck on the
// onboarding overlay instead of the search UI these tests exercise.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('preferredLanguage', 'en');
      localStorage.setItem('ppp_purpose', 'lectures');
    } catch (e) {}
  });
});

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

  test('P15. Onboarding purpose choice triggers the mandatory first-use install (core+EN premium+EN raw+shards); "In Text" is gated until it lands, works after', async ({ page }) => {
    // Rājan decision 2026-07-26: online text search is no longer offered at
    // all, so every user installs the full EN dataset (incl. the sentence
    // shards) right after the onboarding purpose choice, before the app is
    // usable. This test does NOT use the file's ppp_purpose bypass — it
    // drives the REAL onboarding gate.
    test.setTimeout(150000);
    await page.addInitScript(() => {
      try {
        localStorage.removeItem('ppp_purpose');
        localStorage.setItem('preferredLanguage', 'en');
        // ppp_auto_install skips the confirmation click and runs the REAL
        // install (same convention as startFirstInstallFlow/beginInstall
        // elsewhere in this file); EN-only base for speed over localhost.
        localStorage.setItem('ppp_auto_install', '1');
        localStorage.setItem('ppp_install_langs', '[]');
      } catch (e) {}
    });
    await page.goto('./');

    // Onboarding gate shows (language stage first) — no data load has
    // started yet: loadData() defers its online fallback while no purpose
    // is chosen (see loadData()/_startMandatoryInstallGate in app.js).
    await expect(page.locator('#onboardingOverlay')).toBeVisible();
    // No data load has started yet — placeholder still says "Loading the
    // database…", never the lecture-count text loadDataLegacy() would set.
    await expect(page.locator('#searchTerm')).toHaveAttribute('placeholder', /Loading/i);

    await page.locator('button.onb-lang').first().click(); // English
    await expect(page.locator('.onb-stage[data-onb-stage="intro"]')).toBeVisible();

    // Choose "quotes" — fires _startMandatoryInstallGate() -> the real
    // install (ppp_auto_install skips the click).
    await page.click('.onb-col-b .onb-go');
    await expect(page.locator('#onboardingOverlay')).toBeHidden();

    // The mandatory install actually runs (progress bar visible) and lands
    // the shards flag downloader.js persists.
    await page.waitForFunction(() => {
      const bar = document.getElementById('progressBar');
      return !!bar && bar.style.display !== 'none';
    }, { timeout: 20000 });

    const deadline = Date.now() + 120000;
    let shardsInstalled = false;
    while (Date.now() < deadline && !shardsInstalled) {
      shardsInstalled = await page.evaluate(async () => {
        if (!(window.PPP && PPP.offlineStore)) return false;
        return !!(await PPP.offlineStore.getState('shards'));
      });
      if (!shardsInstalled) await page.waitForTimeout(500);
    }
    expect(shardsInstalled).toBe(true);

    // App opens (openFromIdb, post-install) usable in "In Text" mode
    // (setPurpose('quotes') already set searchMode to 'sentences') and a
    // real sentence search runs — no install-required notice, no shard
    // fetch over the network.
    await waitForDataReady(page);
    await page.fill('#searchTerm', 'krishna');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#resultsInfo strong', { timeout: 30000 });
    const info = await page.locator('#resultsInfo strong').textContent();
    expect(info).toMatch(/Found \d+ sentences/);
  });

  test('P15b. TRUE first-use, no ppp_auto_install hook: the install prompt shows a manifest-derived size and offers no way past it (all-or-nothing)', async ({ page }) => {
    // P15 above uses the ppp_auto_install=1 test hook, which every OTHER
    // test in this suite also sets — that hook is exactly why two real
    // regressions in commit 0f09795 shipped invisible to the 108-test gate:
    // with the hook, the mandatory install always runs immediately and the
    // "nothing installed yet" state (no install screen shown at all; a text
    // search silently doing nothing) is never exercised. This test drives
    // the onboarding gate and the search gate with NO auto-install hook at
    // all — the same path a real first-time visitor takes — and a "Continue
    // without text search" escape hatch instead of waiting out a real
    // ~190 MB download over localhost.
    test.setTimeout(60000);
    await page.addInitScript(() => {
      try {
        localStorage.removeItem('ppp_purpose');
        localStorage.removeItem('ppp_auto_install');
        localStorage.setItem('preferredLanguage', 'en');
      } catch (e) {}
    });
    await page.goto('./');

    await expect(page.locator('#onboardingOverlay')).toBeVisible();
    await page.locator('button.onb-lang').first().click(); // English
    await expect(page.locator('.onb-stage[data-onb-stage="intro"]')).toBeVisible();

    // Choose "quotes" — real setPurpose() -> _startMandatoryInstallGate() ->
    // startFirstInstallFlow(), with NO auto-install hook this time: the
    // fetchManifest().then(showInstallPrompt(...)) branch must actually run
    // and render the mandatory install step, not silently land in the
    // quotes view the way the regression did.
    await page.click('.onb-col-b .onb-go');
    await expect(page.locator('#onboardingOverlay')).toBeHidden();

    const installSelector = page.locator('#installLangSelect');
    await expect(installSelector).toBeVisible({ timeout: 20000 });

    // The size text (progressBar loading message) is derived from the REAL
    // manifest at runtime (core + EN premium + EN raw + shards), not a
    // hardcoded string — compute the same total the app computes and assert
    // it appears verbatim.
    const expectedMB = (function () {
      var bytes = 0;
      ['meta', 'extras', 'sentences'].forEach(function (k) {
        if (realManifest.core && realManifest.core[k] && realManifest.core[k].size) bytes += realManifest.core[k].size;
      });
      (realManifest.packs || []).forEach(function (p) { if (p.lang === 'en' && p.size) bytes += p.size; });
      (realManifest.sentenceShards || []).forEach(function (s) { if (s && s.size) bytes += s.size; });
      return Math.round(bytes / 1048576);
    })();
    expect(expectedMB).toBeGreaterThan(0);
    await expect(page.locator('#progressBar')).toContainText(String(expectedMB), { timeout: 5000 });

    // All-or-nothing (Rājan 2026-07-26, "kā jebkura spēle — tai nav daļējas
    // lejupielādes"): the ONLY choice on this screen is adding LV and/or RU.
    // There is no way past it — an earlier build offered "Continue without
    // text search" here and let users into a half-app.
    await expect(page.locator('#installSkipBtn')).toHaveCount(0);
    await expect(page.locator('#installOfflineBtn')).toBeVisible();
    const langBoxes = installSelector.locator('input[type=checkbox]');
    expect(await langBoxes.count()).toBe(3);          // EN (base) + LV + RU
    await expect(langBoxes.first()).toBeChecked();    // EN is not optional
    await expect(langBoxes.first()).toBeDisabled();
  });

  test('P15b2. Without an install, a text search still explains itself instead of no-opping', async ({ page }) => {
    // The other half of the old P15b. Reaching "no library installed" no
    // longer means skipping the gate — it means a RETURNING device: the
    // purpose was chosen in an earlier session (so the gate does not re-run)
    // but storage was cleared, or offline is unsupported here. loadData()
    // then takes the loadDataLegacy() online path with no shards, which is
    // exactly the state _requireTextSearchLibrary has to answer for.
    test.setTimeout(60000);
    await page.addInitScript(() => {
      try {
        localStorage.removeItem('ppp_auto_install');
        localStorage.setItem('preferredLanguage', 'en');
        localStorage.setItem('ppp_purpose', 'quotes');
      } catch (e) {}
    });
    await page.goto('./');
    await expect(page.locator('#onboardingOverlay')).toBeHidden();

    // The returning-device path lands in the normal (online) quotes view —
    // usable, just without the sentence shards. #searchTerm is
    // re-enabled early by clearComboDisplay(), BEFORE onDataLoaded() flips
    // the internal `dataLoaded` flag doSearch() itself gates on — AND in
    // "sentences" mode updateSearchModePlaceholder() always shows the real
    // (non-"Loading") placeholder regardless of dataLoaded (unlike metadata
    // mode), so the placeholder text is not a usable readiness signal here
    // (see P1's analogous, but metadata-only, note). loadDataLegacy() calls
    // ui.hideLoading() and onDataLoaded() back-to-back synchronously, so
    // waiting for the loading overlay to actually disappear is the reliable
    // proxy for "dataLoaded is now true".
    const searchInput = page.locator('#searchTerm');
    await expect(searchInput).toBeEnabled({ timeout: 20000 });
    await expect(page.locator('#progressBar')).toBeHidden({ timeout: 20000 });

    // The regression: typing a term and pressing Search silently did
    // nothing (no message, no overlay, #resultsInfo stayed empty). Assert
    // the REQUIRED behaviour instead — a visible, localized explanation
    // plus an install affordance, every time a text search is attempted
    // without the library, via every entry point the fix documents.
    const expectedShardsMB = Math.round(
      (realManifest.sentenceShards || []).reduce(function (sum, s) { return sum + ((s && s.size) || 0); }, 0) / 1048576
    );
    expect(expectedShardsMB).toBeGreaterThan(0);

    await page.fill('#searchTerm', 'peacock');
    await page.keyboard.press('Enter');
    const notice = page.locator('#resultsInfo .quotes-require-install');
    await expect(notice).toBeVisible({ timeout: 10000 });
    await expect(notice).toContainText(String(expectedShardsMB));
    const installOffer = page.locator('#resultsInfo button', { hasText: 'Install library' });
    await expect(installOffer).toBeVisible();

    // The offer button opens the SAME offline-install panel used elsewhere
    // — not a dead click, not a duplicate/second installer.
    await installOffer.click();
    await expect(page.locator('#offlineInfoPanel')).toBeVisible();
  });

  test('P15c. A hung offlineStore.getState (never resolves, never rejects) still produces a visible notice within a few seconds, not a silent no-op', async ({ page }) => {
    // Rājan field report (2026-07-26): on a real device,
    // PPP.offlineStore.getState('shards') can hang forever — never resolve,
    // never reject (private browsing, a tab holding a blocking IndexedDB
    // transaction, a wedged embedded webview). A plain .then()/.catch()
    // cannot help: nothing ever fires. _requireTextSearchLibrary (and every
    // other offlineStore read gating a visible onboarding/search response)
    // must race such a call against a short timeout instead of trusting it
    // to eventually settle on its own. This test proves that: the stub
    // NEVER settles, at all, ever — if the gate did not have a timeout,
    // this test would hang until Playwright's own test timeout killed it.
    test.setTimeout(30000);
    await page.addInitScript(() => {
      try {
        localStorage.removeItem('ppp_auto_install');
        localStorage.setItem('preferredLanguage', 'en');
        localStorage.setItem('ppp_purpose', 'quotes');
      } catch (e) {}
    });
    // Returning device, nothing installed (storage cleared / offline
    // unsupported) — the same route P15b2 uses now that the install gate has
    // no way past it.
    await page.goto('./');
    await expect(page.locator('#searchTerm')).toBeEnabled({ timeout: 20000 });
    await expect(page.locator('#progressBar')).toBeHidden({ timeout: 20000 });

    // Stub getState so it NEVER settles — not slow, not eventually
    // rejecting, just permanently pending, exactly like the field report.
    await page.evaluate(() => {
      PPP.offlineStore.getState = function () { return new Promise(function () {}); };
    });

    const start = Date.now();
    await page.fill('#searchTerm', 'peacock');
    await page.keyboard.press('Enter');

    const notice = page.locator('#resultsInfo .quotes-require-install');
    await expect(notice).toBeVisible({ timeout: 8000 });
    const elapsedMs = Date.now() - start;
    // The internal timeout is 4000ms — the notice must land comfortably
    // before Playwright's own assertion timeout, proving the gate resolved
    // itself rather than the stub ever answering.
    expect(elapsedMs).toBeLessThan(7000);

    // Still a real, localized, actionable message — not a blank fallback.
    await expect(notice).toContainText(/library|MB/i);
    const installOffer = page.locator('#resultsInfo button', { hasText: 'Install library' });
    await expect(installOffer).toBeVisible();
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
            Object.keys(installState.completedCore || {}).length === 3 &&
            Object.keys(installState.completedPacks || {}).length >= expectedDonePacks) break;
        if (Date.now() > deadline) break;
        await page.waitForTimeout(500);
      }
      expect(installState).not.toBeNull();
      expect(Object.keys(installState.completedCore || {}).length).toBe(3);
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

  test('PL1. Install prompt shows 2 opt-in language checkboxes (EN+shards mandatory, no shard checkbox); size grows with LV/RU selection', async ({ page }) => {
    // Rājan decision 2026-07-26: the sentence shards (offline "In Text"
    // search) are no longer opt-in — they join the mandatory EN base, since
    // online text search is no longer offered at all. This supersedes the
    // opt-in shard-checkbox behaviour PL1 used to assert (base ≈151 MB,
    // +~200 MB only after ticking a checkbox); the checkbox is gone and the
    // mandatory base size already includes the shards from the start.
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

    // No opt-in shard checkbox anymore — the shards are mandatory.
    await expect(page.locator('#installLangSelect input[data-shard]')).toHaveCount(0);

    // The mandatory base (EN + core + sentence shards) is ≈ 330-360 MB —
    // the old ~151 MB EN-only figure plus the ~200 MB of sentence shards,
    // present from the very first render (no checkbox to tick).
    const baseTxt = await page.textContent('#installLangSelect .offline-lang-size');
    const baseMB = parseInt(String(baseTxt).replace(/[^0-9]/g, ''), 10);
    expect(baseMB).toBeGreaterThan(320);
    expect(baseMB).toBeLessThan(360);

    // Tick LV + RU → displayed size grows further (prem-lv + prem-ru packs
    // on top of the already-mandatory shard-inclusive base).
    await page.check('#installLangSelect input[data-lang="lv"]');
    await page.check('#installLangSelect input[data-lang="ru"]');
    const fullTxt = await page.textContent('#installLangSelect .offline-lang-size');
    const fullMB = parseInt(String(fullTxt).replace(/[^0-9]/g, ''), 10);
    expect(fullMB).toBeGreaterThan(baseMB);
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

// ===========================================================================
// Phase B — INTERRUPTED install: a half-downloaded library must still be a
// FULLY OFFLINE app, and must finish itself.
//
// User-reported bug: after a download that broke off, "even English texts
// don't work offline" — the app had ~150 MB in IndexedDB and still refused to
// open without a network, because offline usability was gated on the
// `localManifest` state key, which firstInstall only writes when EVERY item
// succeeded.
//
// The fix (js/downloader.js firstInstall + js/app.js loadData):
//   * one failed item no longer aborts the pool — failures are collected and
//     firstInstall rejects with err.partial / failedItems / doneBytes /
//     totalBytes AFTER the rest of the library has landed;
//   * on a partial failure `localManifest` is deliberately NOT written (it must
//     keep meaning "complete install" — checkForUpdates treats it as ground
//     truth), while the `install` resume state (with .langs/.shards) survives;
//   * a `coreReady` flag is set the moment core:meta + core:extras commit;
//   * loadData(): no localManifest + resume state + coreReady → openFromIdb(),
//     i.e. the app opens from IndexedDB with ZERO network, and resumes the
//     rest by itself when online.
// ===========================================================================

/** The smallest EN pack — the one we sabotage. Small on purpose: the item is
 *  retried MAX_ATTEMPTS=4 times with 1s/4s/10s backoff, so the cheapest
 *  possible failing item keeps the wall clock down. Picked from the real
 *  manifest — pack ids regenerate with every DB build. */
const SMALLEST_EN_PACK = realManifest.packs
  .filter(p => p.lang === 'en')
  .slice()
  .sort((a, b) => a.size - b.size)[0];

/**
 * Drive a REAL install (EN base only — ppp_install_langs='[]') with exactly
 * one pack permanently failing, and return once the pool has finished and
 * firstInstall has rejected with err.partial. The interrupted-copy in
 * #offlineProgress (i18n offlineInterrupted, rendered ONLY in the
 * `err.partial` branch of startBackgroundInstall) is the end-of-pool signal —
 * unlike an IDB poll it cannot fire while items are still in flight.
 */
async function makePartialInstall(page, blockedPack) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('ppp_auto_install', '1');
      localStorage.setItem('ppp_install_langs', '[]'); // EN base only — smaller/faster
    } catch (e) {}
  });
  await page.route('**/' + blockedPack.path + '*', route => route.abort());
  await page.goto('./');
  await expect(page.locator('#offlineProgress'))
    .toContainText('Download interrupted', { timeout: 260000 });
}

/** Read the offline-install state keys straight out of IndexedDB. */
function readOfflineState(page) {
  return page.evaluate(async () => ({
    localManifest: await PPP.offlineStore.getState('localManifest'),
    install: await PPP.offlineStore.getState('install'),
    coreReady: await PPP.offlineStore.getState('coreReady'),
    langs: await PPP.offlineStore.getState('langs'),
  }));
}

/** Make a page believe it has no connection BEFORE any app code runs
 *  (navigator.onLine drives loadData's resume/update branches and net.online). */
function forceOffline(page) {
  return page.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'onLine', { get: function () { return false; }, configurable: true });
    } catch (e) {}
  });
}

test.describe('PWA interrupted install (Phase B)', () => {
  // Two full ~151 MB EN-base installs fit in the resume test; the others do
  // one plus a 15 s retry ladder. The 90 s config timeout is far too small.
  test.setTimeout(420000);

  // Same rationale as the blocks above: page.route must deterministically see
  // every request, so no service worker may sit in front of the network.
  test.describe('deterministic network (SW blocked)', () => {
    test.use({ serviceWorkers: 'block' });

    test('P7. Partial install leaves a resumable, NON-complete state (no localManifest, install kept, coreReady set)', async ({ page }) => {
      await makePartialInstall(page, SMALLEST_EN_PACK);

      const state = await readOfflineState(page);

      // (a) The completeness fence was NOT advanced — a library with a hole
      // must never look "installed" to checkForUpdates.
      expect(state.localManifest).toBeNull();

      // (b) The resume state survived the failure, carrying the selection.
      expect(state.install).not.toBeNull();
      expect(state.install.completedPacks[SMALLEST_EN_PACK.id]).toBeUndefined();

      // (c) Both core files committed → the cheap offline-capable flag is set.
      expect(state.coreReady).toBe(true);
      // All three core files land (see P14 — `sentences` is part of the base),
      // but coreReady is gated on meta+extras only, so it flips long before.
      expect(Object.keys(state.install.completedCore).sort())
        .toEqual(['extras', 'meta', 'sentences']);

      // (d) Everything else really did land: the pool ran to the end instead
      // of aborting on the first failure (the old behaviour).
      const enPacks = realManifest.packs.filter(p => p.lang === 'en').length;
      expect(Object.keys(state.install.completedPacks).length).toBe(enPacks - 1);
    });

    test('P8. A partial library opens FULLY OFFLINE (regression: "even English texts don\'t work offline")', async ({ page, context }) => {
      await makePartialInstall(page, SMALLEST_EN_PACK);
      await page.close();

      // New page in the SAME context (same IndexedDB) with an airtight data
      // blackout: every manifest/DB/pack/transcript request is aborted, and
      // navigator.onLine is false before any app code runs, so nothing can
      // silently repair the library mid-test. The shell (html/css/js/wasm) is
      // still served because service workers are blocked in this describe —
      // there is no SW cache to serve it from, and the shell is not what this
      // regression is about; the DATA must come from IndexedDB alone.
      const page2 = await context.newPage();
      await forceOffline(page2);
      const dataRequests = [];
      page2.on('request', req => {
        if (/\/(packs\/|transcripts\/|data\/)/.test(req.url())) dataRequests.push(req.url());
      });
      await page2.route(/\/(packs\/|transcripts\/|data\/)/, route => route.abort());

      await page2.goto('./');

      // The app opens from IndexedDB — this is the whole bug.
      await waitForDataReady(page2, 60000);
      await expectSearchWorks(page2, 'krishna');

      // It did NOT fall into the legacy "Requires an internet connection" dead
      // end (loadDataLegacy's offline guard).
      await expect(page2.locator('#progressBar')).toBeHidden();
      const label = await page2.locator('#progressBar .progress-label').textContent();
      expect(label || '').not.toMatch(/Requires an internet/i);

      // Not one byte of data came from the network.
      expect(dataRequests).toEqual([]);
      await page2.close();
    });

    test('P9. Auto-resume: the interrupted install finishes itself, with no click', async ({ page, context }) => {
      await makePartialInstall(page, SMALLEST_EN_PACK);
      const before = await readOfflineState(page);
      expect(before.localManifest).toBeNull();
      await page.close();

      // Same context, no abort route this time, online. NOTHING is clicked:
      // loadData() sees resume+coreReady, opens from IDB and calls
      // startBackgroundInstall(resume.langs, resume.shards) by itself.
      const page2 = await context.newPage();
      const packRequests = [];
      page2.on('request', req => {
        if (req.url().includes('/packs/')) packRequests.push(req.url());
      });
      await page2.goto('./');

      // Opens offline-style from IDB immediately (partial branch), then the
      // resume commits the completeness fence.
      await waitForDataReady(page2, 60000);
      await waitForLocalManifestSet(page2, 180000);

      // localManifest lands a few IDB transactions BEFORE `langs`/`shards` are
      // written and `install` is deleted — poll for the tail of that chain
      // instead of racing it (Node-side poll, see the note in P3).
      const cleanupDeadline = Date.now() + 30000;
      for (;;) {
        const s = await readOfflineState(page2);
        if (s.install === null) break;
        if (Date.now() > cleanupDeadline) break;
        await page2.waitForTimeout(250);
      }

      const after = await readOfflineState(page2);
      expect(after.localManifest).not.toBeNull();
      expect(after.install).toBeNull();          // resume state cleaned up
      expect(after.langs).toEqual([]);           // EN-base selection persisted

      // Only the missing pack was re-fetched — the resume did not restart.
      expect(packRequests.length).toBeGreaterThanOrEqual(1);
      for (const url of packRequests) {
        expect(url).toContain(SMALLEST_EN_PACK.id);
      }
      await page2.close();
    });

    test('P10. Delta-update path unchanged: checkForUpdates does NOT complete a partial library', async ({ page, context }) => {
      await makePartialInstall(page, SMALLEST_EN_PACK);
      await page.close();

      // Offline-forced boot (so the auto-resume cannot run and finish the
      // library behind the assertion), packs/DBs blocked, but data/manifest.json
      // allowed so checkForUpdates can really fetch a remote manifest.
      const page2 = await context.newPage();
      await forceOffline(page2);
      const packRequests = [];
      page2.on('request', req => {
        if (req.url().includes('/packs/')) packRequests.push(req.url());
      });
      await page2.route(/\/(packs\/|transcripts\/|data\/ppp_)/, route => route.abort());

      await page2.goto('./');
      await waitForDataReady(page2, 60000);

      // At the moment the app first opens, the library is explicitly NOT
      // flagged complete — offline usability came from the records, not the
      // manifest fence.
      const atOpen = await readOfflineState(page2);
      expect(atOpen.localManifest).toBeNull();
      expect(atOpen.install).not.toBeNull();

      // Run the delta check explicitly: with no localManifest it must be a
      // no-op (downloader.checkForUpdates early-returns) — it must never fill
      // the holes nor write the fence. Only firstInstall/resume may do that.
      const res = await page2.evaluate(() => PPP.downloader.checkForUpdates());
      expect(res.changedItems).toBe(0);

      const afterCheck = await readOfflineState(page2);
      expect(afterCheck.localManifest).toBeNull();
      expect(afterCheck.install).not.toBeNull();
      expect(packRequests).toEqual([]);
      await page2.close();
    });

    test('P11. The selection chosen at install START is persisted on the resume state', async ({ page }) => {
      // Ask for a non-default selection (LV on top of the EN base). Only the
      // START of the install matters here: firstInstall persists the `install`
      // record — carrying .langs/.shards — BEFORE the pool runs, so a later
      // auto-resume continues exactly what the user chose without asking again.
      await page.addInitScript(() => {
        try {
          localStorage.setItem('ppp_auto_install', '1');
          localStorage.setItem('ppp_install_langs', '["lv"]');
        } catch (e) {}
      });
      await page.goto('./');

      // Node-side poll (see the async-predicate note in P3).
      const deadline = Date.now() + 60000;
      let install = null;
      for (;;) {
        install = await page.evaluate(async () => {
          if (!(window.PPP && PPP.offlineStore)) return null;
          return PPP.offlineStore.getState('install').catch(() => null);
        });
        if (install) break;
        if (Date.now() > deadline) break;
        await page.waitForTimeout(250);
      }
      expect(install).not.toBeNull();
      expect(install.langs).toEqual(['lv']);   // EN is the implicit base
      expect(install.shards).toBe(false);      // ppp_install_shards not set

      // And getResumeState() surfaces exactly that selection to the boot path.
      const resume = await page.evaluate(() => PPP.downloader.getResumeState());
      expect(resume.langs).toEqual(['lv']);
      expect(resume.shards).toBe(false);
    });
  });
});

// ===========================================================================
// Field bugs 2026-07-24 (production reports from real devices).
//
// P12 — iPad install loop: one item's IndexedDB write kept failing with
// QuotaExceededError (WebKit runs out of origin storage long before desktop
// Chrome; the storage preflight is advisory). The old code spent the whole
// 4-attempt retry ladder RE-DOWNLOADING the item to fail at the same write,
// raised err.partial, and the auto-resume restarted the identical round:
// 69% → 79% → 69% forever, with no cause shown. New behaviour: quota errors
// fail FAST (single attempt), firstInstall tags the rejection with
// .quotaExceeded, the UI shows the storage-full copy (i18n offlineStorageFull)
// instead of the generic interrupted copy, and the automatic-resume listeners
// are DISARMED so the loop cannot restart by itself (manual Retry stays).
//
// P13 — Android "Valoda nav lejupielādēta" on an INSTALLED language: the
// transcript packs are built from a snapshot while the meta DB (which renders
// the EN/LV/RU/Raw buttons) is rebuilt daily, so a lecture added after the
// pack build shows a button yet has no IndexedDB record. Offline, the old
// code showed "language not downloaded" even for EN — the mandatory base that
// IS installed. New behaviour: when the requested language is installed, the
// copy says the LECTURE is newer than the offline library (i18n
// offlineLectureNotInLibrary); the language-not-downloaded copy remains for
// genuinely un-downloaded languages.
// ===========================================================================

test.describe('Field bugs 2026-07-24 (quota loop, missing-lecture copy)', () => {
  test.setTimeout(300000);

  // page.route / request tracking must deterministically see every request.
  test.describe('deterministic network (SW blocked)', () => {
    test.use({ serviceWorkers: 'block' });

    test('P12. QuotaExceededError: fail-fast (no retry ladder), storage-full copy, auto-resume disarmed', async ({ page }) => {
      await page.goto('./');
      await page.waitForFunction(() =>
        window.PPP && PPP.app && PPP.downloader && PPP.offlineStore && PPP.offlineStore.supported());

      const packReqs = [];
      page.on('request', req => { if (req.url().includes('/packs/')) packReqs.push(req.url()); });

      // Every files-store write fails the way a full WebKit origin fails:
      // an asynchronous QuotaExceededError out of the IndexedDB transaction.
      await page.evaluate(() => {
        const quotaReject = () =>
          Promise.reject(new DOMException('The quota has been exceeded.', 'QuotaExceededError'));
        PPP.offlineStore.putFile = quotaReject;
        PPP.offlineStore.applyPack = quotaReject;
      });

      // Drive the real background-install path (EN base) and wait for it to
      // run to completion — the catch branch renders into #offlineProgress.
      await page.evaluate(() => PPP.app.startBackgroundInstall([], false));

      // (a) The user is told the REAL cause — storage, not a vague interrupt.
      await expect(page.locator('#offlineProgress'))
        .toContainText('Not enough storage on the device', { timeout: 60000 });

      // (b) Fail-fast: every item was fetched exactly ONCE — the old retry
      // ladder re-downloaded each failing item up to 4 times.
      const counts = {};
      for (const u of packReqs) counts[u] = (counts[u] || 0) + 1;
      expect(packReqs.length).toBeGreaterThan(0);
      for (const u of Object.keys(counts)) expect(counts[u]).toBe(1);

      // (c) The library never claims completeness, and the durable resume
      // state survives for a later (post-cleanup) manual retry or boot resume.
      const state = await page.evaluate(async () => ({
        localManifest: await PPP.offlineStore.getState('localManifest'),
        install: await PPP.offlineStore.getState('install'),
      }));
      expect(state.localManifest).toBeNull();
      expect(state.install).not.toBeNull();

      // (d) The automatic-resume loop is BROKEN: an 'online' burst plus a
      // visibilitychange must no longer restart the install by itself.
      const before = packReqs.length;
      await page.evaluate(() => {
        window.dispatchEvent(new Event('online'));
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForTimeout(2000);
      expect(packReqs.length).toBe(before);
    });

    test('P13. Offline, installed EN: a lecture missing from the packs gets the "newer than the library" copy, not "language not downloaded"', async ({ page, context }) => {
      await installEnOnly(page);

      await context.setOffline(true);
      try {
        // (a) EN — the mandatory installed base. An nr with no IDB record
        // (a lecture added after the pack build) must NOT claim the language
        // is missing; it says the lecture is newer than the library.
        await page.evaluate(() => PPP.app.openHtmlTranscriptViewer('999999', 'en'));
        await expect(page.locator('#transcriptModalBody'))
          .toContainText('newer than your offline library', { timeout: 15000 });
        await expect(page.locator('#transcriptModalTitle'))
          .toContainText('Not in the offline library yet');
        await page.keyboard.press('Escape');

        // (b) LV — genuinely NOT selected/downloaded: the language-not-
        // downloaded guidance stays exactly as before (PL4 behaviour).
        await page.evaluate((nr) => PPP.app.openHtmlTranscriptViewer(nr, 'lv'), LV_NR);
        await expect(page.locator('#transcriptModalBody'))
          .toContainText('not downloaded', { timeout: 15000 });
      } finally {
        await context.setOffline(false);
      }
    });
  });
});

// ===========================================================================
// core.sentences joins the offline base (2026-07-24).
//
// The manifest has always described core.sentences (the EN sentence DB, ~20 MB
// packed / 66 MB raw, behind offline transcript-text search) and db.js has
// always tried to open it as 'core:sentences' — but the downloader hardcoded
// ['meta','extras'] in three places, so the file was never installed and that
// lookup silently fell back to the network: no offline sentence search.
// Now the core key list is one CORE_KEYS constant covering all three files, so
// the base grows by exactly core.sentences.size. The tiered-readiness gate
// (coreReady / isCoreInstalled) is deliberately untouched — meta+extras only.
// ===========================================================================

test.describe('core.sentences in the offline base', () => {
  test.setTimeout(180000);

  test('P14a. computeInstallBytes counts core.sentences: the EN-only base grows by exactly its manifest size', async ({ page }) => {
    await page.goto('./');
    await page.waitForFunction(() => window.PPP && PPP.downloader && PPP.downloader.computeInstallBytes);

    const sizes = await page.evaluate(async () => {
      const m = await PPP.downloader.fetchManifest();
      const enPacks = (m.packs || [])
        .filter(p => p.lang === 'en')
        .reduce((s, p) => s + (p.size || 0), 0);
      return {
        sentences: m.core.sentences ? m.core.sentences.size : 0,
        metaExtras: m.core.meta.size + m.core.extras.size,
        enPacks: enPacks,
        base: PPP.downloader.computeInstallBytes(m, [], false),
        withShards: PPP.downloader.computeInstallBytes(m, [], true),
        shards: (m.sentenceShards || []).reduce((s, x) => s + (x.size || 0), 0),
      };
    });

    // The manifest really describes the sentence DB (guard against a build
    // that stops emitting it — the whole test would otherwise pass vacuously).
    expect(sizes.sentences).toBeGreaterThan(1000000);

    // EN-only base = meta + extras + sentences + EN packs. Stated as an exact
    // identity: the base is the old (meta+extras+packs) total PLUS exactly
    // core.sentences.size — nothing more, nothing double-counted.
    const oldBase = sizes.metaExtras + sizes.enPacks;
    expect(sizes.base).toBe(oldBase + sizes.sentences);

    // The opt-in shard selection is additive on top of the same base.
    expect(sizes.withShards).toBe(sizes.base + sizes.shards);
  });

  test.describe('deterministic network (SW blocked)', () => {
    test.use({ serviceWorkers: 'block' });

    test('P14b. core.sentences is in the install work list: it is downloaded and recorded in completedCore', async ({ page }) => {
      // Mock the manifest down to core-only (no packs, no shards) so this test
      // exercises the CORE work list in seconds instead of pulling the whole
      // ~151 MB EN base. Same page.route fixture technique as P4/PL3.
      const coreOnly = JSON.parse(JSON.stringify(realManifest));
      coreOnly.packs = [];
      coreOnly.sentenceShards = [];
      expect(coreOnly.core.sentences).toBeTruthy();

      await page.route('**/data/manifest.json*', route => route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(coreOnly),
      }));

      const coreReqs = [];
      page.on('request', req => {
        const u = req.url();
        if (/\/data\/ppp_(meta|lecture_extras|sentences_en)/.test(u)) coreReqs.push(u);
      });

      await addAutoInstallHook(page);
      await page.goto('./');
      await waitForLocalManifestSet(page, 150000);

      // (a) The sentence DB was actually fetched — the whole point: before the
      // fix the work list only ever contained meta + extras.
      expect(coreReqs.some(u => u.includes(realManifest.core.sentences.path))).toBe(true);

      // (b) It is in IndexedDB under the key db.js opens ('core:sentences'),
      // decompressible and of the manifest's raw size.
      const stored = await page.evaluate(async () => {
        const gz = await PPP.offlineStore.getGz('core:sentences');
        return gz ? gz.byteLength : 0;
      });
      expect(stored).toBe(realManifest.core.sentences.size);

      // (c) Recorded in the durable resume state, so a resume never re-pulls it.
      const install = await page.evaluate(() => PPP.offlineStore.getState('install'));
      const local = await page.evaluate(() => PPP.offlineStore.getState('localManifest'));
      expect(local).not.toBeNull();
      // A COMPLETED install deletes `install`; when it is still present (timing),
      // sentences must already be flagged there.
      if (install) {
        expect(Object.keys(install.completedCore).sort())
          .toEqual(['extras', 'meta', 'sentences']);
      }
    });
  });

  // =========================================================================
  // P14c/P14d — the delta-update side of the same change. Once core.sentences
  // is installed, checkForUpdates() can report coreChanged.sentences, but
  // backgroundUpdateCheck() only ever handled meta and extras: a running
  // session kept querying the sentence DB it opened at startup until reload.
  // Both tests stub checkForUpdates rather than mutate a remote manifest —
  // the branch under test is app-side wiring, not diff computation.
  // =========================================================================

  /** Make checkForUpdates() report exactly the given coreChanged flags. */
  function stubUpdateResult(page, coreChanged) {
    return page.evaluate((flags) => {
      window.__reloadCalls = { meta: 0, sentences: 0 };
      PPP.downloader.checkForUpdates = function () {
        return Promise.resolve({ changedItems: 1, coreChanged: flags });
      };
      const realMeta = PPP.db.reloadMetaFromStore;
      PPP.db.reloadMetaFromStore = function () {
        window.__reloadCalls.meta += 1;
        return Promise.resolve(false);   // no view refresh — not under test
      };
      const realSentences = PPP.db.reloadSentencesFromStore;
      PPP.db.reloadSentencesFromStore = function () {
        window.__reloadCalls.sentences += 1;
        return realSentences.call(PPP.db);
      };
      void realMeta;
    }, coreChanged);
  }

  test('P14c. a delta update that changed core.sentences reloads the sentence DB in place', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));

    await page.goto('./');
    await page.waitForFunction(() => window.PPP && PPP.db && PPP.app && PPP.downloader);

    // The reload entry point must exist and be exported next to its meta twin.
    expect(await page.evaluate(() => typeof PPP.db.reloadSentencesFromStore)).toBe('function');

    // (a) sentences-only change → the sentence branch fires, meta's does not.
    await stubUpdateResult(page, { meta: false, extras: false, sentences: true });
    await page.evaluate(() => PPP.app._backgroundUpdateCheckForTest());
    await expect.poll(() => page.evaluate(() => window.__reloadCalls.sentences)).toBe(1);
    expect(await page.evaluate(() => window.__reloadCalls.meta)).toBe(0);

    // (b) The reload is a no-op when this session never opened the sentence DB
    // — it must not gratuitously pull ~66 MB into memory on an update note.
    expect(await page.evaluate(() => PPP.db.isSentencesLoaded())).toBe(false);
    expect(await page.evaluate(() => PPP.db.reloadSentencesFromStore())).toBe(false);

    // (c) A failing refresh is swallowed: no unhandled rejection, app alive.
    await page.evaluate(() => {
      PPP.db.reloadSentencesFromStore = function () {
        return Promise.reject(new Error('boom'));
      };
    });
    await page.evaluate(() => PPP.app._backgroundUpdateCheckForTest());
    await page.waitForTimeout(500);
    expect(pageErrors).toEqual([]);
    expect(await page.evaluate(() => !!(PPP.app && PPP.db))).toBe(true);

    // (d) meta still routes to its own reload (the branch was not disturbed).
    await stubUpdateResult(page, { meta: true, extras: false, sentences: false });
    await page.evaluate(() => PPP.app._backgroundUpdateCheckForTest());
    await expect.poll(() => page.evaluate(() => window.__reloadCalls.meta)).toBe(1);
    expect(await page.evaluate(() => window.__reloadCalls.sentences)).toBe(0);
  });

  // SW blocked: the service worker answers data/manifest.json from its cache,
  // which both defeats page.route and makes the read counter meaningless.
  test.describe('deterministic network (SW blocked, shard cache)', () => {
    test.use({ serviceWorkers: 'block' });

    test('P14d. an applied delta drops the memoized shard list so the next sentence search re-reads the manifest', async ({ page }) => {
      // Shard-less manifest fixture: _getSentenceShards() resolves [] and
      // searchSentencesChunked rejects immediately — enough to prove WHEN the
      // manifest is read without fetching a single ~30 MB shard.
      const noShards = JSON.parse(JSON.stringify(realManifest));
      noShards.sentenceShards = [];

      let manifestReads = 0;
      await page.route('**/data/manifest.json*', route => {
        manifestReads += 1;
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(noShards) });
      });

      await page.goto('./');
      await page.waitForFunction(() => window.PPP && PPP.db && PPP.app && PPP.downloader);
      // Let the boot-time manifest reads (offer panel / downloader) settle
      // first, so the counter only moves for reads this test triggers.
      await page.waitForTimeout(2000);

      const probe = () => page.evaluate(() =>
        PPP.db.searchSentencesChunked('SELECT 1', 'SELECT 1', { $limit: 1 })
          .then(() => 'resolved', e => e.message));

      // Two searches, one manifest read: the list is memoized (existing design).
      expect(await probe()).toContain('No sentence shards');
      const afterFirst = manifestReads;
      expect(await probe()).toContain('No sentence shards');
      expect(manifestReads).toBe(afterFirst);

      // An applied delta invalidates it — the next search re-reads the manifest.
      await stubUpdateResult(page, { meta: false, extras: false, sentences: false });
      await page.evaluate(() => PPP.app._backgroundUpdateCheckForTest());
      await page.waitForTimeout(500);
      expect(await probe()).toContain('No sentence shards');
      expect(manifestReads).toBe(afterFirst + 1);
    });
  });
});

test.describe('Service Worker cannot pair a new index.html with old JS (Codex, 2026-07-26)', () => {

  test('P18. A versioned asset request is never answered from a different version in cache', async ({ page }) => {
    // Navigations are network-first, so right after a deploy a fresh index.html
    // with NEW ?v= hashes can render while the PREVIOUS shell cache is still
    // active. The static-asset branch matched ignoreSearch:true, so it happily
    // returned the OLD app.js for a request naming the new one — the exact skew
    // that broke production on 2026-07-26, invisible to every test.
    test.setTimeout(90000);

    await page.goto('./');
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));

    // Wait for the shell precache to exist (poll from Node — an async predicate
    // inside waitForFunction resolves truthy immediately and ends it vacuously).
    let shell = null;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && !shell) {
      shell = await page.evaluate(async () => {
        const names = await caches.keys();
        const n = names.find(x => x.indexOf('ca-shell-') === 0);
        if (!n) return null;
        const c = await caches.open(n);
        return (await c.keys()).length >= 10 ? n : null;
      });
      if (!shell) await page.waitForTimeout(500);
    }
    expect(shell, 'shell cache never filled').not.toBeNull();

    // Make the ONLY cached entry for this path a stale version. Without
    // dropping the precached real one first, caches.match(ignoreSearch) could
    // return that instead and the test would pass on the old code too.
    const planted = await page.evaluate(async (name) => {
      const c = await caches.open(name);
      const keys = await c.keys();
      let removed = 0;
      for (const k of keys) {
        if (new URL(k.url).pathname.endsWith('/js/app.js')) { await c.delete(k); removed++; }
      }
      await c.put('js/app.js?v=stale001',
        new Response('/* STALE-CACHED-BODY */', { headers: { 'Content-Type': 'application/javascript' } }));
      return removed;
    }, shell);
    expect(planted, 'precached js/app.js not found — cache layout changed').toBeGreaterThan(0);

    // Ask for a DIFFERENT version. The old code answered this from the stale
    // cache entry; it must now go to the network and get the real file.
    const body = await page.evaluate(() =>
      fetch('js/app.js?v=fresh002').then(r => r.text()));

    expect(body).not.toContain('STALE-CACHED-BODY');
    expect(body).toContain('PPP Link Finder');
  });

  test('P18b. Unversioned assets still come from cache (the loose match is not gone)', async ({ page }) => {
    // The fix must not turn every cache hit into a network round-trip: refs
    // without ?v= (woff2 from fonts.css, vendor libs) rely on the loose match.
    test.setTimeout(90000);

    await page.goto('./');
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));

    let shell = null;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && !shell) {
      shell = await page.evaluate(async () => {
        const names = await caches.keys();
        const n = names.find(x => x.indexOf('ca-shell-') === 0);
        if (!n) return null;
        const c = await caches.open(n);
        return (await c.keys()).length >= 10 ? n : null;
      });
      if (!shell) await page.waitForTimeout(500);
    }
    expect(shell).not.toBeNull();

    await page.evaluate(async (name) => {
      const c = await caches.open(name);
      await c.put('unversioned-probe.txt?ignored=1',
        new Response('FROM-CACHE', { headers: { 'Content-Type': 'text/plain' } }));
    }, shell);

    // No ?v= on the request, and the network would 404 — the loose match must
    // still answer it.
    const body = await page.evaluate(() =>
      fetch('unversioned-probe.txt').then(r => r.text()).catch(e => 'ERR:' + e.message));
    expect(body).toContain('FROM-CACHE');
  });

  test('P18c. The db-worker ?v= is a content hash, so its request hits the precache exactly', async ({ page }) => {
    // Consequence of P18: an exact-match rule only works if every ?v= is a
    // content hash. js/db-worker.js was requested as '?v=cache5' — a
    // hand-written label — while build_sw_precache.py stored the entry under
    // the sha256[:8] hash, so this asset missed the cache on EVERY load and
    // left a duplicate entry behind. scripts/cache_bust.py (JS_REFS) keeps the
    // reference in js/db.js in sync now; this test fails if a label comes back.
    test.setTimeout(90000);

    await page.goto('./');
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));

    let shell = null;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && !shell) {
      shell = await page.evaluate(async () => {
        const names = await caches.keys();
        const n = names.find(x => x.indexOf('ca-shell-') === 0);
        if (!n) return null;
        const c = await caches.open(n);
        return (await c.keys()).length >= 10 ? n : null;
      });
      if (!shell) await page.waitForTimeout(500);
    }
    expect(shell, 'shell cache never filled').not.toBeNull();

    // Read the reference the app really uses, from source — never hardcode the
    // hash here, it changes with every db-worker.js edit.
    const ref = await page.evaluate(async () => {
      const src = await fetch('js/db.js').then(r => r.text());
      const m = src.match(/new Worker\(['"]([^'"]+)['"]\)/);
      return m ? m[1] : null;
    });
    expect(ref, 'no new Worker(...) reference found in js/db.js').not.toBeNull();
    expect(ref, 'the worker ?v= must be a sha256[:8] content hash, not a label')
      .toMatch(/^js\/db-worker\.js\?v=[0-9a-f]{8}$/);

    // Exact match, the way sw.js v10 answers a ?v= request.
    const hit = await page.evaluate(async (url) => {
      const r = await caches.match(url);
      return !!r;
    }, ref);
    expect(hit, 'the URL the app requests is not a precache key: ' + ref).toBe(true);

    // And the old style would indeed have missed — that is what made this a bug.
    const labelHit = await page.evaluate(async () => !!(await caches.match('js/db-worker.js?v=cache5')));
    expect(labelHit).toBe(false);
  });

});

test.describe('The device stores the library once (measured install, 2026-07-27)', () => {

  test('P19. Sentence shards never land in the Service Worker cache as a second copy', async ({ page }) => {
    // Found by running a real full install in a browser and measuring, which no
    // test did: the shell cache had grown to 232 MB because v10's "data/ is
    // cache-first" rule also caught the 21 shards. The device then held 342 MB
    // in IndexedDB plus a second 191 MB copy in the SW cache — 574 MB for a
    // 342 MB install — and nothing ever read the SW copy.
    test.setTimeout(180000);

    await addAutoInstallHook(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('ppp_install_shards', '1'); } catch (e) {}
    });
    await page.goto('./');
    await waitForLocalManifestSet(page, 150000);

    // Shards are in IndexedDB — that is where they belong.
    const inIdb = await page.evaluate(() => PPP.offlineStore.getState('shards'));
    expect(inIdb).toBe(true);

    // …and nowhere in the shell cache.
    const cachedShards = await page.evaluate(async () => {
      const names = await caches.keys();
      const out = [];
      for (const n of names) {
        const c = await caches.open(n);
        for (const k of await c.keys()) {
          if (new URL(k.url).pathname.indexOf('/data/shards/') !== -1) out.push(k.url);
        }
      }
      return out;
    });
    expect(cachedShards).toEqual([]);
  });

});

test.describe('ZIP export uses the installed library (Rājan, 2026-07-26)', () => {
  test.use({ serviceWorkers: 'block' });

  test('P17. With the library installed, a ZIP is built without touching the network', async ({ page }) => {
    // ZIP predates the offline library and never caught up: it asked the network
    // for premium HTML and Google Drive for raw text, both of which are already
    // on the device. So ZIP did not work offline at all, and online it
    // re-downloaded what the user had already paid for. Every existing ZIP test
    // passed throughout, because they all run online.
    test.setTimeout(180000);

    await addAutoInstallHook(page);
    await page.goto('./');
    await waitForLocalManifestSet(page, 130000);
    await page.reload();
    await waitForDataReady(page);

    // Hard-block both sources ZIP used to depend on. Any attempt is a failure,
    // not a slow path — record it rather than letting it fall back quietly.
    const blocked = [];
    await page.route('**/transcripts/**', route => { blocked.push(route.request().url()); route.abort(); });
    await page.route('**googleapis.com**', route => { blocked.push(route.request().url()); route.abort(); });

    await page.fill('#searchTerm', 'krishna');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.select-checkbox[data-lang="en"]', { timeout: 20000 });

    // Pick a lecture whose premium transcript really is in IDB.
    const nr = await page.evaluate(async () => {
      const boxes = [...document.querySelectorAll('.select-checkbox[data-lang="en"]')];
      for (const b of boxes) {
        const n = b.getAttribute('data-nr');
        const txt = await PPP.offlineStore.getText('t:en:' + n).catch(() => null);
        if (txt && txt.trim()) return n;
      }
      return null;
    });
    expect(nr, 'no EN premium transcript found in IDB after install').not.toBeNull();

    await page.locator(`.select-checkbox[data-lang="en"][data-nr="${nr}"]`).check();
    await page.click('#downloadSelectedBtn');
    await page.fill('#zipNameInput', 'offline zip test');

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      page.click('#zipDownloadBtn'),
    ]);
    expect(download.suggestedFilename()).toBe('offline_zip_test.zip');

    // A real document inside, not an empty archive (an empty zip is ~22 bytes).
    const fs = require('fs');
    const path = await download.path();
    expect(fs.statSync(path).size).toBeGreaterThan(500);

    // And the proof: neither the transcripts path nor Drive was ever asked.
    expect(blocked).toEqual([]);
  });

});

test.describe('The mandatory install cannot freeze the app (Codex + Sabhā, 2026-07-26)', () => {

  test('P16. An install that never progresses ends in a message with Try again, not a permanent freeze', async ({ page }) => {
    // The gate has no skip button by design (Rājan: all-or-nothing, "like any
    // game — there is no partial download"). That makes a non-settling install
    // fatal: firstInstall() awaits getState('install') with no timeout, and a
    // wedged IndexedDB (private browsing, embedded webview, another tab holding
    // a version-change transaction) neither resolves NOR rejects — so the
    // .then/.catch that disarm the click guard never run and every button on
    // the page answers with a toast forever. Codex flagged it CRITICAL and all
    // three Sabhā members reached the same conclusion from the product side.
    //
    // The watchdog waits 45 s of total silence, hence the long timeout. That
    // wait IS the subject: without it this test would hang until Playwright
    // killed it, which is exactly the user's experience.
    test.setTimeout(120000);

    // The file-level beforeEach presets ppp_purpose for every test here, which
    // skips the onboarding gate — and the gate is what triggers the mandatory
    // install. Init scripts run in registration order, so removing it here
    // (second) is what makes this path reachable at all.
    await page.addInitScript(() => {
      try {
        localStorage.removeItem('ppp_auto_install');
        localStorage.removeItem('ppp_purpose');
        localStorage.setItem('preferredLanguage', 'en');
      } catch (e) {}
    });
    await page.goto('./');

    // An install that never settles: no progress event, no resolve, no reject.
    await page.waitForFunction(() => window.PPP && PPP.downloader, { timeout: 20000 });
    await page.evaluate(() => {
      PPP.downloader.firstInstall = function () { return new Promise(function () {}); };
    });

    // initOnboarding always opens at the language stage when no purpose is set,
    // whatever preferredLanguage says — so pick a language, then a purpose.
    await page.locator('button.onb-lang').first().click();   // English
    await page.click('.onb-col-a .onb-go');                  // "Browse lectures"
    await expect(page.locator('#installOfflineBtn')).toBeVisible({ timeout: 20000 });
    await page.click('#installOfflineBtn');

    // The watchdog must turn the silence into something the user can act on.
    await expect(page.locator('#installStallRetryBtn')).toBeVisible({ timeout: 75000 });
    await expect(page.locator('#progressBar')).toContainText('cannot continue');

    // The Try again button is reachable — that is the whole point of the fix.
    await expect(page.locator('#installStallRetryBtn')).toBeEnabled();

    // But the app itself stays gated. Disarming the guard here was the obvious
    // move and it was wrong: it left the search box live in front of no data, so
    // pressing Search did nothing at all. Found by hand in a real browser, not
    // by this suite. The guard stays armed and answers with the reason.
    await page.fill('#searchTerm', 'krishna');
    await page.locator('button.search-button').first().click({ force: true });
    await expect(page.locator('#uiToast')).toContainText('has to be downloaded', { timeout: 5000 });
    expect(await page.locator('#resultsTable tbody tr').count()).toBeLessThan(2);
  });

});

test.describe('An installed library never fetches a shard behind the user (A2, 2026-07-27)', () => {
  // The shard reader failed closed for "no record in IDB", but its OUTER catch
  // swallowed a failure of the IndexedDB read ITSELF (quota, corrupt store,
  // aborted transaction) and went to the network — the exact metered download
  // the all-or-nothing install forbids (Rājan, 2026-07-26).
  //
  // No install is needed to exercise it: the fence reads PPP.offlineStore, so
  // the store is stubbed to fail the way a damaged IDB does. That keeps the
  // test at a few seconds instead of a 342 MB install, and it also lets the
  // NEGATIVE case (no library installed → the network IS the normal path) be
  // checked, which a real install cannot do.
  test.use({ serviceWorkers: 'block' });

  /** Stub the offline store: reads always blow up; 'shards' state as given. */
  async function withBrokenIdb(page, shardsInstalled) {
    return page.evaluate(function (installed) {
      PPP.offlineStore.supported = function () { return true; };
      PPP.offlineStore.getGz = function () {
        // What a corrupted/aborted IndexedDB read looks like — NOT "no record",
        // which resolves with undefined and is handled on the hot path.
        return Promise.reject(new DOMException('backing store failure', 'UnknownError'));
      };
      PPP.offlineStore.getState = function (key) {
        return Promise.resolve(key === 'shards' ? installed : null);
      };
      PPP.db.resetLibraryInstalledCache();   // the memo must not hide the answer
      return PPP.db.searchSentencesChunked(
        'SELECT 1 AS n', null, { $limit: 1 }
      ).then(function () {
        return { threw: false, repair: false, msg: '' };
      }, function (e) {
        return { threw: true, repair: e && e.shardRepairNeeded === true, msg: String(e && e.message) };
      });
    }, shardsInstalled);
  }

  test('P20. IDB read error + shards installed → repair error, zero shard requests', async ({ page }) => {
    const shardReqs = [];
    page.on('request', r => {
      if (r.url().indexOf('/data/shards/') !== -1) shardReqs.push(r.url());
    });

    await page.goto('./');
    await page.waitForFunction(() => window.PPP && PPP.db && PPP.offlineStore, { timeout: 30000 });

    const res = await withBrokenIdb(page, true);
    expect(res.threw).toBe(true);
    expect(res.repair, 'a damaged library must surface the repair path: ' + res.msg).toBe(true);
    expect(shardReqs, 'an installed device fetched a shard from the network').toEqual([]);
  });

  test('P20b. Same IDB read error with NO library installed → the network stays the normal path', async ({ page }) => {
    // The other half of the fence. Failing closed for everyone would kill
    // search for online users with no install (Fable, 2026-07-27), so this
    // must NOT become a repair error.
    const shardReqs = [];
    page.on('request', r => {
      if (r.url().indexOf('/data/shards/') !== -1) shardReqs.push(r.url());
    });
    // Abort the shard download: the attempt is the assertion, the ~9 MB is not.
    await page.route('**/data/shards/**', route => route.abort());

    await page.goto('./');
    await page.waitForFunction(() => window.PPP && PPP.db && PPP.offlineStore, { timeout: 30000 });

    const res = await withBrokenIdb(page, false);
    expect(res.repair, 'a device with no install must not be told to repair').toBe(false);
    expect(shardReqs.length, 'the online fallback fetch never happened').toBeGreaterThan(0);
  });

});

// ===========================================================================
// A stalled install must STOP, stay gated, and resume by itself
// (Fable review, 2026-07-27 — three defects the 110-test suite did not cover)
// ===========================================================================
//
// Why these exist: the suite was green while all three bugs were live, because
// no test ever reached the state they live in. Each test below was verified to
// FAIL on the pre-fix code — the concrete failure is recorded in each test.
test.describe('A stalled install stops, stays gated and resumes itself (2026-07-27)', () => {

  /**
   * Reach the mandatory install gate. The file-level beforeEach presets
   * ppp_purpose for every test here, which skips onboarding — and onboarding is
   * what triggers the gate — so this init script (registered second, therefore
   * running second) undoes it. Same trick as P16.
   */
  async function openGate(page) {
    await page.addInitScript(() => {
      try {
        localStorage.removeItem('ppp_auto_install');
        localStorage.removeItem('ppp_purpose');
        localStorage.setItem('preferredLanguage', 'en');
      } catch (e) {}
    });
    await page.goto('./');
    await page.waitForFunction(() => window.PPP && PPP.downloader, { timeout: 30000 });
  }

  /** Language -> purpose -> the Download button of the mandatory prompt. */
  async function pressDownload(page) {
    await page.locator('button.onb-lang').first().click();   // English
    await page.click('.onb-col-a .onb-go');                  // "Browse lectures"
    await expect(page.locator('#installOfflineBtn')).toBeVisible({ timeout: 20000 });
    await page.click('#installOfflineBtn');
  }

  test('P21. The stall watchdog ABORTS the download, and Try again waits for it to stop', async ({ page }) => {
    // A1. The watchdog used to only drop its promise: the pool underneath kept
    // downloading, so Try again ran a SECOND one over the same 342 MB — double
    // data on exactly the weak connections that stall, two writers on the same
    // `install` record, and the stuck download's result thrown away if it did
    // finish. The 45 s silence window is the subject, hence the long timeout.
    //
    // NEGATIVE CHECK (verified against HEAD = 62336dd, pre-fix js/app.js):
    // this test failed at the first assertion with
    //   "Error: app.js must pass an abort signal into firstInstall
    //    Expected: true / Received: false"
    // because beginInstall called firstInstall(onProgress, langs, includeShards)
    // with no fourth argument — there was no cancellation channel at all.
    test.setTimeout(200000);
    await openGate(page);

    // An install that never settles by itself; the test settles call #1 by hand.
    await page.evaluate(() => {
      window.__calls = [];
      PPP.downloader.firstInstall = function (onProgress, langs, shards, signal) {
        const rec = { signal: signal, settle: null, sawAbortEvent: false };
        if (signal && signal.addEventListener) {
          signal.addEventListener('abort', () => { rec.sawAbortEvent = true; });
        }
        window.__calls.push(rec);
        return new Promise((resolve, reject) => { rec.settle = () => reject({ aborted: true }); });
      };
    });

    await pressDownload(page);
    await expect(page.locator('#installStallRetryBtn')).toBeVisible({ timeout: 90000 });

    // 1. The app handed the downloader a real cancellation channel...
    expect(
      await page.evaluate(() => !!(window.__calls[0] && window.__calls[0].signal)),
      'app.js must pass an abort signal into firstInstall'
    ).toBe(true);

    // 2. ...and the watchdog actually pulled it.
    expect(
      await page.evaluate(() => !!(window.__calls[0].signal.aborted || window.__calls[0].sawAbortEvent)),
      'the watchdog must abort the underlying download, not just drop the promise'
    ).toBe(true);

    // 3. Try again must not start a second pool while the first is still alive.
    //    1.5 s is well inside the 5 s cancel bound, so this is not a race.
    await page.click('#installStallRetryBtn');
    await page.waitForTimeout(1500);
    expect(
      await page.evaluate(() => window.__calls.length),
      'a second install started while the first had not stopped'
    ).toBe(1);

    // 4. Only once the cancelled work has unwound may attempt 2 begin.
    await page.evaluate(() => window.__calls[0].settle());
    await page.waitForFunction(() => window.__calls.length === 2, { timeout: 15000 });
    expect(
      await page.evaluate(() => window.__calls.length),
      'exactly one retry, started only after the first stopped'
    ).toBe(2);
  });

  test('P22. A partial install with no usable core stays gated instead of going online', async ({ page }) => {
    // A3. The third way a failed install quietly turned the mandatory gate into
    // an optional one. 28468a2 (point 1d) closed the other two; this one kept
    // falling through to loadDataLegacy(), handing the user the half-app the
    // all-or-nothing decision exists to prevent.
    //
    // NEGATIVE CHECK (verified against HEAD = 62336dd, pre-fix js/app.js):
    //   "expect(locator).toBeVisible() failed — Locator: #installStallRetryBtn
    //    Expected: visible / Timeout: 30000ms / element(s) not found"
    // i.e. no error screen was ever rendered, because the app had already
    // opened in online mode behind the gate.
    await openGate(page);

    await page.evaluate(() => {
      PPP.downloader.firstInstall = function () {
        return Promise.reject({ partial: true, totalBytes: 200000000, doneBytes: 1000, failedItems: [] });
      };
      PPP.downloader.isCoreReady = function () { return Promise.resolve(false); };
    });

    await pressDownload(page);

    // The gate holds: the honest error screen, not the online app.
    await expect(page.locator('#installStallRetryBtn')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#progressBar')).toContainText('cannot continue');

    // And the app itself is still unusable — the click guard answers instead of
    // a dead Search button in front of no data.
    await page.fill('#searchTerm', 'krishna');
    await page.locator('button.search-button').first().click({ force: true });
    await expect(page.locator('#uiToast')).toBeVisible({ timeout: 8000 });
    expect(await page.locator('#resultsTable tbody tr').count()).toBeLessThan(2);
  });

  test('P23. The error screen keeps auto-resume: "online" retries by itself, tab switches do not burn the budget', async ({ page }) => {
    // A4. The error paths used to remove the 'online'/'visibilitychange'
    // listeners, so a network blip that would have healed itself turned into
    // "the user must notice and press a button" — a regression aimed precisely
    // at the bad connections that produce this screen.
    //
    // NEGATIVE CHECK (verified against HEAD = 62336dd, pre-fix js/app.js):
    // the run died inside waitForFunction waiting for a second install attempt
    // that never came ("page.waitForFunction: Test timeout of 200000ms
    // exceeded") — no event reached anything, because _removeInstallListeners()
    // had already run on the stalled path.
    //
    // The second half guards the fix's own follow-up defect: charging the retry
    // budget at the TICK meant two tab switches exhausted AUTO_FAIL_MAX and
    // disarmed the listeners, re-creating the same regression from the other
    // side. The budget is now spent only by an automatic attempt that FAILS.
    test.setTimeout(200000);
    await openGate(page);

    await page.evaluate(() => {
      window.__calls = [];
      PPP.downloader.firstInstall = function (onProgress, langs, shards, signal) {
        const rec = { signal: signal, settle: null };
        window.__calls.push(rec);
        // Call #1 hangs (the stall). Later calls fail fast so the error screen
        // returns and attempts stay countable.
        if (window.__calls.length === 1) {
          return new Promise((resolve, reject) => { rec.settle = () => reject({ aborted: true }); });
        }
        return Promise.reject(new Error('still failing'));
      };
    });

    await pressDownload(page);
    await expect(page.locator('#installStallRetryBtn')).toBeVisible({ timeout: 90000 });

    // The stuck attempt was aborted; let it unwind so the (correct)
    // single-flight wait is not what the next assertion measures.
    await page.evaluate(() => window.__calls[0].settle && window.__calls[0].settle());
    await page.waitForTimeout(300);

    // Coming back to the tab is a genuine resume opportunity, so the FIRST one
    // does start attempt 2 (which fails fast here).
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(() => window.__calls.length === 2, { timeout: 15000 });

    // The SECOND one, moments later, must not — otherwise flicking between
    // tabs relaunches a failing install over and over.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(1000);
    expect(
      await page.evaluate(() => window.__calls.length),
      'a rapid second tab switch must not relaunch the install'
    ).toBe(2);

    // The decisive one: the network comes back, nobody touches the screen, and
    // it resumes anyway. This is what proves a tab switch did NOT spend the
    // retry budget — when the tick itself was charged, two visibility ticks
    // exhausted AUTO_FAIL_MAX and this 'online' event reached nothing.
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => window.__calls.length >= 3, { timeout: 15000 });
    expect(
      await page.evaluate(() => window.__calls.length),
      'an online event on the error screen must resume the install'
    ).toBeGreaterThanOrEqual(3);
  });

});
