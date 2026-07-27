/*
 * GC-THRESHOLD HYPOTHESIS — does the search peak scale with the LIVE heap?
 *
 * Claim under test: V8 grows the allocation limit proportionally to the live
 * heap, so a smaller idle heap lowers the GC trigger, leaves less floating
 * garbage during the search, and therefore lowers the search peak.
 *
 * Method: ONE browser launch, ONE process sampler, N live-heap levels
 * interleaved round-robin (separate launches drift the renderer baseline by
 * tens of MB and would swamp the effect). The app itself is untouched — the
 * live-heap level is set by mutating what the page already holds:
 *
 *   prod      extras cache as production leaves it (all 6 languages)
 *   active    non-active-language keys deleted from every extras entry
 *   none      PPP.ui.clearExtrasCache()  (whole extras object collectable)
 *   ballastNN prod + NN MB of deliberately retained strings
 *
 * Every level carries a MODE ECHO that is *measured*, not declared: the probe
 * counts the surviving per-language keys and the harness throws if they do not
 * match the level. A stale service-worker copy of the app, or a level whose
 * mutation silently failed, fails the run instead of producing a plausible
 * number. Service workers are blocked outright and the page asserts
 * navigator.serviceWorker.controller === null.
 *
 * All heap numbers are taken AFTER HeapProfiler.collectGarbage on the page
 * isolate AND on the db-worker isolate. performance.memory is not used.
 *
 * Usage:
 *   node bench/gc/run-gc.cjs --repeat 3 --term krishna \
 *        --level prod --level active --level none --level ballast60
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { chromium } = require(path.join(__dirname, '..', '..', 'node_modules', 'playwright'));
const { Cdp } = require('./cdp.cjs');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const args = (n) => argv.reduce((a, v, i) => (v === '--' + n ? a.concat(argv[i + 1]) : a), []);

const REPEAT = Number(arg('repeat', '3'));
const TERM = arg('term', 'krishna');
const PORT = Number(arg('port', '8899'));
const CDP_PORT = Number(arg('cdpPort', '9444'));
const LANG = arg('lang', 'en');
const OUTNAME = arg('out', 'results-gc');
const LEVELS = args('level').length ? args('level') : ['prod', 'active', 'none', 'ballast60'];
const EXPECT_SCOPED = argv.includes('--expect-scoped');   // ui.js fix present?
const EXPECT_UNSCOPED = argv.includes('--expect-unscoped');

const ORIGIN = 'http://localhost:' + PORT;
const PROFILE = path.join(process.env.TEMP || '/tmp', 'ca-gc-profile');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const MB = n => (n == null || Number.isNaN(n)) ? 'n/a' : (n / 1e6).toFixed(1);

// ---- per-language extras keys, mirrored from js/ui.js getters -------------
const LANGS = ['lv', 'ru', 'es', 'it', 'fr'];

// ============================ page-side helpers ============================
// Everything below runs INSIDE the page. Kept as plain functions passed to
// page.evaluate so there is exactly one definition per concern.

/** Count extras keys by kind. Full sweep (not a sample) so the echo is exact. */
function PROBE() {
    const ui = window.PPP && window.PPP.ui;
    const out = {
        swController: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
        extrasReady: !!(ui && ui.extrasReady && ui.extrasReady()),
        scopeVersion: (ui && ui.__extrasScopeVersion) || null,
        entries: 0, keys: {}, otherLangKeys: 0,
        ballastCopies: (window.__gcBallast || []).length,
        ballastEntries: (window.__gcBallast || []).reduce((a, o) => a + Object.keys(o).length, 0)
    };
    const probe = ui && ui.__benchExtras ? ui.__benchExtras() : window.__gcExtrasRef;
    if (!probe) return out;
    const langs = ['lv', 'ru', 'es', 'it', 'fr'];
    for (const nr in probe) {
        const e = probe[nr];
        if (!e || typeof e !== 'object') continue;
        out.entries++;
        for (const k in e) out.keys[k] = (out.keys[k] || 0) + 1;
    }
    for (const k in out.keys) {
        const m = /^([set])(.+)$/.exec(k);
        if (m && langs.indexOf(m[2]) >= 0) out.otherLangKeys += out.keys[k];
    }
    return out;
}

/** Delete every non-active-language key from every extras entry, in place. */
function PRUNE(lang) {
    const ui = window.PPP && window.PPP.ui;
    const ref = (ui && ui.__benchExtras) ? ui.__benchExtras() : window.__gcExtrasRef;
    if (!ref) return { pruned: -1 };
    const langs = ['lv', 'ru', 'es', 'it', 'fr'];
    const keep = {};
    keep['s'] = 1; keep['e'] = 1;                  // EN base — the fallback
    if (lang && lang !== 'en') {
        keep['s' + lang] = 1; keep['e' + lang] = 1; keep['t' + lang] = 1;
    }
    let pruned = 0;
    for (const nr in ref) {
        const e = ref[nr];
        if (!e || typeof e !== 'object') continue;
        for (const k in e) {
            const m = /^([set])(.+)$/.exec(k);
            if (m && langs.indexOf(m[2]) >= 0 && !keep[k]) { delete e[k]; pruned++; }
        }
    }
    return { pruned };
}

/**
 * Retain `copies` extra deep copies of the extras cache.
 *
 * Deliberately NOT synthetic megabyte strings: `'x'.repeat(1<<20)` does raise
 * real memory but V8's used_heap_size barely moves for it (measured: 60 such
 * strings = 120 MB of characters showed up as +2.1 MB used), so a synthetic
 * ballast would have silently produced a flat ladder. Copying the extras cache
 * reproduces exactly the allocation profile the fix removes — millions of
 * small strings hanging off ~9 800 objects — and it is fully accounted for.
 * The JSON round trip runs in chunks so no single intermediate string is huge.
 */
function BALLAST(copies) {
    const src = window.__gcExtrasRef;
    if (!src) return { err: 'no extras ref' };
    const nrs = Object.keys(src);
    const bag = window.__gcBallast || (window.__gcBallast = []);
    for (let c = 0; c < copies; c++) {
        const copy = {};
        for (let i = 0; i < nrs.length; i += 500) {
            const part = {};
            for (const nr of nrs.slice(i, i + 500)) part[nr] = src[nr];
            Object.assign(copy, JSON.parse(JSON.stringify(part)));
        }
        bag.push(copy);
    }
    window.__gcBallastMB = -1;                      // real size is measured, not declared
    return { copies, entriesPerCopy: nrs.length };
}

// ================================= main ====================================
async function main() {
    fs.mkdirSync(PROFILE, { recursive: true });
    const ctx = await chromium.launchPersistentContext(PROFILE, {
        headless: true,
        serviceWorkers: 'block',
        args: ['--remote-debugging-port=' + CDP_PORT, '--disable-dev-shm-usage'],
        viewport: { width: 1280, height: 900 }
    });
    await ctx.addInitScript((lang) => {
        try {
            localStorage.setItem('preferredLanguage', lang);
            localStorage.setItem('ppp_purpose', 'quotes');
            localStorage.setItem('ppp_onboarded', '1');
        } catch (e) {}
    }, LANG);

    // ---- one-time: install the 21 shards so the search reads the library,
    //      not the network (that is the condition the device is in).
    let page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.PPP && PPP.offlineStore, null, { timeout: 60000 });
    const already = await page.evaluate(() => PPP.offlineStore.getState('shards'));
    if (already !== true) {
        log('installing 21 shards into IndexedDB (one-time for this profile)…');
        const inst = await page.evaluate(async () => {
            const t0 = performance.now();
            const m = await (await fetch('data/manifest.json', { cache: 'no-store' })).json();
            const shards = m.sentenceShards || [];
            let bytes = 0;
            for (const s of shards) {
                const buf = await (await fetch(s.path)).arrayBuffer();
                bytes += buf.byteLength;
                await PPP.offlineStore.putFile({
                    key: 'shard:' + s.id, packId: 'shard:' + s.id,
                    gz: new Blob([buf], { type: 'application/gzip' }),
                    raw: 0, enc: 'gzip'
                });
            }
            await PPP.offlineStore.commitState({ shards: true, localManifest: m }, []);
            return { n: shards.length, bytes, ms: performance.now() - t0 };
        });
        log(`  installed ${inst.n} shards, ${(inst.bytes / 1e6).toFixed(0)} MB, ${(inst.ms / 1000).toFixed(1)} s`);
    } else {
        log('shards already installed in this profile');
    }
    await page.close();

    // ---- process sampler (renderer working set, 120 ms) -------------------
    const samples = [];
    const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(__dirname, 'sampler.ps1'),
        '-Token', '--remote-debugging-port=' + CDP_PORT, '-IntervalMs', '120']);
    let buf = '';
    ps.stdout.on('data', d => {
        buf += d.toString();
        const lines = buf.split(/\r?\n/); buf = lines.pop();
        for (const l of lines) { const [t, r, tot] = l.split('|'); if (t && r) samples.push({ t: +t, r: +r, tot: +tot }); }
    });
    await new Promise(r => setTimeout(r, 3500));

    const results = {};
    LEVELS.forEach(l => results[l] = []);

    for (let rep = 0; rep < REPEAT; rep++) {
        for (const level of LEVELS) {
            const row = await runOne(ctx, level, rep);
            results[level].push(row);
        }
    }

    ps.kill();
    const summary = summarize(results);
    console.log('\n' + summary);
    fs.writeFileSync(path.join(__dirname, OUTNAME + '-' + TERM + '.json'),
        JSON.stringify({ term: TERM, lang: LANG, levels: LEVELS, repeat: REPEAT, results }, null, 2));
    fs.writeFileSync(path.join(__dirname, OUTNAME + '-' + TERM + '.txt'), summary + '\n');
    await ctx.close();
    log('done');

    // ---------------------------------------------------------------- inner
    async function runOne(ctx, level, rep) {
        const page = await ctx.newPage();
        page.on('console', m => { if (m.type() === 'error') log('  [page error]', m.text().slice(0, 160)); });
        await page.goto(ORIGIN, { waitUntil: 'load', timeout: 90000 });
        await page.waitForFunction(() => {
            const i = document.getElementById('searchTerm');
            return i && !i.disabled;
        }, null, { timeout: 120000 });
        // extras load starts after the meta DB is ready — wait for it, else
        // "prod" would be measured with a half-filled cache.
        await page.waitForFunction(() => window.PPP && PPP.ui && PPP.ui.extrasReady && PPP.ui.extrasReady(),
            null, { timeout: 120000 });
        await page.waitForTimeout(3000);

        // Reference to the live extras object. loadExtras() resolves with
        // _extrasCache ITSELF (js/ui.js:1205), so this is the very object the
        // cache holds — no copy, nothing extra retained. getExtras() is not
        // exported, so this is the only public door.
        await page.evaluate(async () => {
            window.__gcExtrasRef = await PPP.ui.loadExtras();
        });

        const cdp = await Cdp.connect(CDP_PORT);
        const pageT = await cdp.attach(t => t.type === 'page' && t.url.indexOf(ORIGIN) === 0);
        if (!pageT) throw new Error('no page target');
        await cdp.send('Runtime.enable', {}, pageT.sessionId);
        await cdp.send('HeapProfiler.enable', {}, pageT.sessionId);
        let wT = await attachWorker(cdp);
        if (wT) await cdp.send('HeapProfiler.enable', {}, wT.sessionId).catch(() => {});

        const gc = async (sid) => {
            await cdp.send('HeapProfiler.collectGarbage', {}, sid);
            await cdp.send('HeapProfiler.collectGarbage', {}, sid);
        };
        const usage = async (sid) => {
            try { return await cdp.send('Runtime.getHeapUsage', {}, sid); }
            catch (e) { return { usedSize: null, totalSize: null, error: String(e.message || e) }; }
        };

        // ---- apply the live-heap level ----------------------------------
        let mutation = null;
        if (level === 'prod') {
            mutation = { kind: 'prod' };
        } else if (level === 'active') {
            mutation = await page.evaluate(PRUNE, LANG);
            mutation.kind = 'active';
        } else if (level === 'none') {
            await page.evaluate(() => {
                window.__gcExtrasRef = null;
                if (PPP.ui.clearExtrasCache) PPP.ui.clearExtrasCache();
            });
            mutation = { kind: 'none' };
        } else if (/^ballastx(\d+)$/.test(level)) {
            mutation = await page.evaluate(BALLAST, Number(/^ballastx(\d+)$/.exec(level)[1]));
            mutation.kind = 'ballast';
            if (mutation.err) throw new Error('ballast failed: ' + mutation.err);
        } else {
            throw new Error('unknown level ' + level);
        }

        await gc(pageT.sessionId);
        await page.waitForTimeout(700);
        await gc(pageT.sessionId);
        if (wT) await gc(wT.sessionId).catch(() => {});

        // ---- MODE ECHO: measured, not declared --------------------------
        const probe = await page.evaluate(PROBE);
        assertEcho(level, probe);

        const preUse = await usage(pageT.sessionId);
        const preWorker = wT ? await usage(wT.sessionId) : null;

        const tBase = Date.now();
        await page.waitForTimeout(1800);
        const baseline = median(samples.filter(s => s.t >= tBase).map(s => s.r));

        // ---- the real UI sentence search --------------------------------
        await page.evaluate(() => {
            const b = document.querySelector('.search-mode-btn[data-mode="sentences"]');
            if (b && !b.classList.contains('active')) b.click();
        });
        await page.waitForTimeout(400);

        const tStart = Date.now();
        const isoPoll = pollIsolates(cdp, pageT, wT, usage);
        const search = await page.evaluate(async (q) => {
            const input = document.getElementById('searchTerm');
            const btn = document.querySelector('.search-row .search-button');
            if (!btn) return { err: 'no search button' };
            input.disabled = false;
            input.value = q;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            const bar = document.getElementById('progressBar');
            const t0 = performance.now();
            btn.click();
            let engaged = false;
            const engDeadline = t0 + 8000;
            while (performance.now() < engDeadline) {
                await new Promise(r => setTimeout(r, 25));
                if (btn.classList.contains('is-cancel') || (bar && getComputedStyle(bar).display !== 'none')) { engaged = true; break; }
            }
            const deadline = t0 + 300000;
            while (performance.now() < deadline) {
                await new Promise(r => setTimeout(r, 50));
                const busyBar = bar && getComputedStyle(bar).display !== 'none';
                const busyBtn = btn.classList.contains('is-cancel');
                if (engaged && !busyBar && !busyBtn) {
                    return {
                        ms: performance.now() - t0, engaged,
                        info: ((document.getElementById('resultsInfo') || {}).textContent || '').trim().slice(0, 160),
                        rows: document.querySelectorAll('#resultsTable tr, #resultsTable .sentence-result').length
                    };
                }
            }
            return { ms: performance.now() - t0, engaged, timeout: true };
        }, TERM);
        const tEnd = Date.now();
        const iso = isoPoll.stop();

        await page.waitForTimeout(2200);
        const win = samples.filter(s => s.t >= tStart && s.t <= tEnd + 1500);
        const peak = win.length ? Math.max(...win.map(s => s.r)) : NaN;

        if (!wT) { wT = await attachWorker(cdp); if (wT) await cdp.send('HeapProfiler.enable', {}, wT.sessionId).catch(() => {}); }
        await gc(pageT.sessionId);
        if (wT) await gc(wT.sessionId).catch(() => {});
        await page.waitForTimeout(1500);
        const settleWin = samples.filter(s => s.t > tEnd + 1500);
        const settled = median(settleWin.map(s => s.r));
        const postUse = await usage(pageT.sessionId);
        const postWorker = wT ? await usage(wT.sessionId) : null;

        const row = {
            level, rep, mutation, probeEcho: {
                entries: probe.entries, otherLangKeys: probe.otherLangKeys,
                extrasReady: probe.extrasReady, scopeVersion: probe.scopeVersion,
                ballastCopies: probe.ballastCopies, ballastEntries: probe.ballastEntries,
                swController: probe.swController
            },
            baselineMB: baseline, peakMB: peak, deltaPeakMB: peak - baseline, settledMB: settled,
            idlePageUsed: preUse.usedSize, idlePageTotal: preUse.totalSize,
            idleWorkerUsed: preWorker && preWorker.usedSize, idleWorkerTotal: preWorker && preWorker.totalSize,
            postPageUsed: postUse.usedSize, postWorkerUsed: postWorker && postWorker.usedSize,
            isoPeakPageUsed: iso.peakPageUsed, isoPeakPageTotal: iso.peakPageTotal,
            isoPeakWorkerUsed: iso.peakWorkerUsed, isoPeakWorkerTotal: iso.peakWorkerTotal,
            isoSamples: iso.n,
            searchMs: search.ms, searchRows: search.rows, searchInfo: search.info,
            searchTimeout: !!search.timeout, procSamples: win.length
        };
        log(`[rep ${rep + 1}] ${level.padEnd(10)} idlePage=${MB(preUse.usedSize).padStart(6)} ` +
            `base=${baseline.toFixed(1).padStart(6)} peak=${peak.toFixed(1).padStart(6)} ` +
            `DELTA=${row.deltaPeakMB.toFixed(1).padStart(6)} settled=${settled.toFixed(1).padStart(6)} ` +
            `wkrPeakTotal=${MB(iso.peakWorkerTotal).padStart(6)} pagePeakTotal=${MB(iso.peakPageTotal).padStart(6)} ` +
            `t=${(search.ms / 1000).toFixed(1)}s rows=${search.rows}`);

        cdp.close();
        await page.close();
        await new Promise(r => setTimeout(r, 2500));
        return row;
    }
}

async function attachWorker(cdp) {
    for (let i = 0; i < 12; i++) {
        const a = await cdp.attach(t => (t.type === 'worker' || t.type === 'shared_worker') && /db-worker/.test(t.url));
        if (a) return a;
        await new Promise(r => setTimeout(r, 250));
    }
    return null;
}

/** Poll both isolates' used/total during the search (no GC — pure read). */
function pollIsolates(cdp, pageT, wT, usage) {
    const st = { peakPageUsed: 0, peakPageTotal: 0, peakWorkerUsed: 0, peakWorkerTotal: 0, n: 0 };
    let live = true;
    (async () => {
        while (live) {
            try {
                const p = await usage(pageT.sessionId);
                if (p && p.usedSize) {
                    st.peakPageUsed = Math.max(st.peakPageUsed, p.usedSize);
                    st.peakPageTotal = Math.max(st.peakPageTotal, p.totalSize || 0);
                }
                if (wT) {
                    const w = await usage(wT.sessionId);
                    if (w && w.usedSize) {
                        st.peakWorkerUsed = Math.max(st.peakWorkerUsed, w.usedSize);
                        st.peakWorkerTotal = Math.max(st.peakWorkerTotal, w.totalSize || 0);
                    }
                }
                st.n++;
            } catch (e) { /* target gone mid-search */ }
            await new Promise(r => setTimeout(r, 150));
        }
    })();
    return { stop() { live = false; return st; } };
}

/**
 * The echo. Every level states, in advance, what the page must MEASURE — a
 * stale service-worker copy, or a mutation that silently did nothing, fails
 * here instead of quietly returning a plausible number.
 */
function assertEcho(level, p) {
    const fail = m => { throw new Error(`MODE ECHO FAILED [${level}]: ${m} — probe=${JSON.stringify(p)}`); };
    if (p.swController) fail('a service worker controls the page (stale code risk)');
    if (EXPECT_SCOPED && !p.scopeVersion) fail('ui.js language-scope fix expected but __extrasScopeVersion is absent');
    if (EXPECT_UNSCOPED && p.scopeVersion) fail('unscoped (pre-fix) ui.js expected but __extrasScopeVersion is present');
    if (level === 'none') {
        if (p.extrasReady) fail('extras cache should be cleared but extrasReady() is true');
        return;
    }
    if (!p.extrasReady) fail('extras cache should be loaded but extrasReady() is false');
    if (p.entries < 5000) fail(`only ${p.entries} extras entries reachable (expected ~9800)`);
    if (level === 'active') {
        if (p.otherLangKeys !== 0) fail(`${p.otherLangKeys} non-active-language keys survived the prune`);
    } else if (level === 'prod' && !EXPECT_SCOPED) {
        if (p.otherLangKeys < 1000) fail(`only ${p.otherLangKeys} non-active-language keys — this is not the production cache`);
    }
    const bm = /^ballastx(\d+)$/.exec(level);
    if (bm) {
        const want = Number(bm[1]);
        if (p.ballastCopies !== want) fail(`expected ${want} retained extras copies, probe sees ${p.ballastCopies}`);
        if (p.ballastEntries < want * 5000) fail(`ballast copies are empty (${p.ballastEntries} entries)`);
    }
}

function summarize(results) {
    const L = [];
    L.push(`GC-THRESHOLD SWEEP — term "${TERM}", lang ${LANG}, ${REPEAT} reps, one browser, interleaved`);
    L.push('');
    L.push('level        n  idlePageUsed  baseRSS   peakRSS  deltaPeak  settled  wkrPeakTotal  pagePeakTotal  searchS');
    for (const lvl of LEVELS) {
        const R = results[lvl] || [];
        if (!R.length) continue;
        L.push([
            lvl.padEnd(11), String(R.length).padStart(2),
            MB(median(R.map(r => r.idlePageUsed))).padStart(13),
            median(R.map(r => r.baselineMB)).toFixed(1).padStart(8),
            median(R.map(r => r.peakMB)).toFixed(1).padStart(9),
            median(R.map(r => r.deltaPeakMB)).toFixed(1).padStart(10),
            median(R.map(r => r.settledMB)).toFixed(1).padStart(8),
            MB(median(R.map(r => r.isoPeakWorkerTotal))).padStart(13),
            MB(median(R.map(r => r.isoPeakPageTotal))).padStart(14),
            (median(R.map(r => r.searchMs)) / 1000).toFixed(1).padStart(8)
        ].join(' '));
    }
    L.push('');
    L.push('Hypothesis reads: if the peak scales with the live heap, deltaPeak (and peakRSS)');
    L.push('must fall monotonically as idlePageUsed falls, and rise under ballast.');
    return L.join('\n');
}

main().catch(e => { console.error('FAIL:', (e && e.stack) || e); process.exit(1); });
