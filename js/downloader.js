/* ===========================================================================
   PPP Link Finder — Offline library downloader
   Downloads the manifest-described core files + transcript packs into the
   IndexedDB offline store (PPP.offlineStore). Byte-weighted progress,
   concurrency 2, resumable (durable per-item install state committed in the
   SAME IndexedDB transaction as the item's file records), delta updates.
   =========================================================================== */
window.PPP = window.PPP || {};

PPP.downloader = (function () {
    'use strict';

    var store = PPP.offlineStore;
    var CONCURRENCY = 2;
    // Core files that every install downloads: the meta DB, the summaries /
    // essence extras, and `sentences` — the EN sentence DB behind offline
    // transcript-text search, which db.js opens as 'core:sentences' (without it
    // that lookup silently falls back to the network, i.e. no offline search).
    // NOTE: the tiered-readiness gate (coreReady / isCoreReady) deliberately
    // waits only for meta+extras, so the app still opens after ~19.5 MB.
    var CORE_KEYS = ['meta', 'extras', 'sentences'];
    // Per-item attempts and the pause before each retry. Mobile networks fail
    // in bursts (tunnel, lift, cell handover) — an immediate second try tends
    // to fail for the same reason, so back off before giving the item up.
    var MAX_ATTEMPTS = 4;
    var RETRY_DELAYS = [1000, 4000, 10000];

    function _delay(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    /**
     * Is this error the browser refusing a write because the origin's storage
     * is full? WebKit (iPad/iPhone) hits this long before desktop Chrome —
     * the storage preflight is advisory (estimate() may be missing or
     * optimistic), so the QuotaExceededError surfaces at APPLY time, from the
     * IndexedDB transaction (offline-store putFile/applyPack reject with
     * tx.error). Matched by DOMException name and, defensively, by message.
     */
    function _isQuotaError(err) {
        if (!err) return false;
        if (err.quota) return true;
        if (err.name === 'QuotaExceededError') return true;
        return /quota/i.test(String(err.message || ''));
    }

    function fetchManifest() {
        return fetch('data/manifest.json', { cache: 'no-store' }).then(function (r) {
            if (!r.ok) throw new Error('manifest HTTP ' + r.status);
            return r.json();
        });
    }

    /**
     * Normalize a selected-language list into the canonical "opt-in" form:
     * an array of language codes to install IN ADDITION to the mandatory EN
     * base. 'en' is always the base and is stripped here; duplicates removed.
     * null/undefined → [] (EN-only base). Accepts an array or a Set-like.
     */
    function _normLangs(langs) {
        var out = [];
        if (!langs) return out;
        for (var i = 0; i < langs.length; i++) {
            var l = langs[i];
            if (l && l !== 'en' && out.indexOf(l) === -1) out.push(l);
        }
        return out;
    }

    /**
     * Is this pack selected for install? EN packs are the mandatory base and
     * are always kept; any other pack is kept only when its language is in the
     * opt-in `langs` list.
     */
    function _packSelected(pack, langs) {
        return pack.lang === 'en' || (langs && langs.indexOf(pack.lang) !== -1);
    }

    /**
     * The manifest to persist as `localManifest`, made to reflect what was
     * actually installed: when the sentence shards are opted out, their list is
     * emptied so the delta check (checkForUpdates) neither spuriously "removes"
     * never-downloaded shards nor re-pulls them. Shallow clone — only the
     * sentenceShards field is replaced.
     */
    function _manifestForStore(manifest, includeShards) {
        if (includeShards) return manifest;
        var copy = {};
        Object.keys(manifest).forEach(function (k) { copy[k] = manifest[k]; });
        copy.sentenceShards = [];
        return copy;
    }

    /**
     * Total install size in bytes for a given selection: every core file plus
     * the mandatory EN packs plus the opt-in language packs. `langs` is the
     * opt-in list (EN excluded); pass [] for the EN-only base. The sentence
     * shards (~200 MB offline text search) are OPT-IN — counted only when
     * `includeShards` is true (default false).
     */
    function computeInstallBytes(manifest, langs, includeShards) {
        var sel = _normLangs(langs);
        var bytes = 0;
        var core = manifest.core || {};
        CORE_KEYS.forEach(function (k) {
            if (core[k] && core[k].size) bytes += core[k].size;
        });
        (manifest.packs || []).forEach(function (p) {
            if (_packSelected(p, sel)) bytes += (p.size || 0);
        });
        if (includeShards) {
            (manifest.sentenceShards || []).forEach(function (s) {
                if (s && s.size) bytes += s.size;
            });
        }
        return bytes;
    }

    function _itemUrl(item) {
        var v = item.hash || (item.sha256 ? String(item.sha256).slice(0, 16) : '');
        return item.path + '?v=' + v;
    }

    /**
     * Fetch one file with byte-level progress. onBytes(n) is called for every
     * received chunk; falls back to a plain arrayBuffer() when the response
     * has no readable body stream.
     */
    function _fetchWithProgress(url, onBytes) {
        return fetch(url, { cache: 'no-store' }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' loading ' + url);
            if (!r.body || !r.body.getReader) {
                return r.arrayBuffer().then(function (buf) {
                    if (onBytes) onBytes(buf.byteLength);
                    return buf;
                });
            }
            var reader = r.body.getReader();
            var chunks = [];
            var received = 0;
            function pump() {
                return reader.read().then(function (res) {
                    if (res.done) return null;
                    chunks.push(res.value);
                    received += res.value.byteLength;
                    if (onBytes) onBytes(res.value.byteLength);
                    return pump();
                });
            }
            return pump().then(function () {
                var out = new Uint8Array(received);
                var off = 0;
                for (var i = 0; i < chunks.length; i++) {
                    out.set(chunks[i], off);
                    off += chunks[i].byteLength;
                }
                return out.buffer;
            });
        });
    }

    function _sha256Hex(buffer) {
        return crypto.subtle.digest('SHA-256', buffer).then(function (digest) {
            var bytes = new Uint8Array(digest);
            var hex = '';
            for (var i = 0; i < bytes.length; i++) {
                hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
            }
            return hex;
        });
    }

    /**
     * Verify a downloaded buffer against its manifest item. Size check always;
     * sha256 check only when the manifest carries a sha256 field (defensive —
     * the build script is being extended to emit it).
     */
    function _verifyBuffer(buffer, item, name) {
        if (item.size != null && buffer.byteLength !== item.size) {
            return Promise.reject(new Error(
                'Size mismatch for ' + name + ': got ' + buffer.byteLength + ', expected ' + item.size));
        }
        if (item.sha256 && window.crypto && crypto.subtle && crypto.subtle.digest) {
            return _sha256Hex(buffer).then(function (hex) {
                if (hex !== String(item.sha256).toLowerCase()) {
                    throw new Error('SHA-256 mismatch for ' + name);
                }
                return buffer;
            });
        }
        return Promise.resolve(buffer);
    }

    function _packKeyFn(pack) {
        if (pack.kind === 'raw') {
            return function (nr) { return 'raw:' + pack.lang + ':' + nr; };
        }
        return function (nr) { return 't:' + pack.lang + ':' + nr; };
    }

    // Single-writer apply queue: downloads run at concurrency 2, but pack /
    // core applies are serialized so only one readwrite transaction touches
    // the store at a time.
    var _applyChain = Promise.resolve();
    function _enqueueApply(fn) {
        var next = _applyChain.then(fn, fn);
        // Keep the chain alive even if an apply fails (error propagates to
        // the caller through `next`, not through the chain).
        _applyChain = next.catch(function () {});
        return next;
    }

    /**
     * Simple promise pool: run worker(item) over items, `concurrency` at a time.
     */
    function _runPool(items, worker, concurrency) {
        var idx = 0;
        function next() {
            if (idx >= items.length) return Promise.resolve();
            var item = items[idx++];
            return worker(item).then(next);
        }
        var runners = [];
        for (var k = 0; k < Math.min(concurrency, items.length); k++) runners.push(next());
        return Promise.all(runners);
    }

    /**
     * Storage preflight: reject when the device clearly lacks room for the
     * bytes still to be written (needBytes × 1.4 headroom). Takes the byte
     * count directly, because on a RESUME only the remaining bytes need room:
     * est.usage already includes everything written so far, so checking the
     * full selection would make a nearly-finished install fail more easily
     * than a fresh one. Advisory API — when estimate() is unavailable the
     * install just proceeds.
     */
    function _storagePreflight(needBytes) {
        if (!(navigator.storage && navigator.storage.estimate)) return Promise.resolve();
        if (!(needBytes > 0)) return Promise.resolve();
        return navigator.storage.estimate().then(function (est) {
            if (!est || est.quota == null || est.usage == null) return;
            var free = est.quota - est.usage;
            if (free < needBytes * 1.4) {
                var err = new Error('Not enough storage: ' + free + ' bytes free');
                err.notEnoughStorage = true;
                throw err;
            }
        }).catch(function (e) {
            if (e && e.notEnoughStorage) throw e;
            // estimate() itself failed — advisory only, proceed.
        });
    }

    /**
     * Download + verify + apply one work item. `install` is the mutable
     * resume-state object; its post-item snapshot is committed in the SAME
     * IndexedDB transaction as the item's file records.
     * item = { type:'core'|'pack', name, coreKey?, pack?, entry }
     */
    function _processItem(item, install, onBytes, resetBytes) {
        var entry = item.entry;
        var attempt = 0;
        function tryOnce() {
            attempt++;
            return _fetchWithProgress(_itemUrl(entry), onBytes)
                .then(function (buf) { return _verifyBuffer(buf, entry, item.name); })
                .then(function (buf) {
                    // The `completedX` flags are set INSIDE the apply callback,
                    // never at download-completion time. Downloads run at
                    // CONCURRENCY 2, but applies are serialized; flagging early
                    // meant item A's transaction could serialize an install
                    // snapshot in which item B was already flagged complete
                    // while B's own transaction had not run yet. A crash in
                    // that window made the resume skip B forever — a silently
                    // missing pack. Inside the apply callback the flag and the
                    // records commit in the SAME transaction.
                    if (item.type === 'core') {
                        var key = 'core:' + item.coreKey;
                        return _enqueueApply(function () {
                            install.completedCore[item.coreKey] = { hash: entry.hash, size: entry.size };
                            return store.putFile(
                                { key: key, packId: key, gz: new Blob([buf], { type: 'application/gzip' }), raw: entry.raw },
                                install._track ? { key: 'install', value: install } : null
                            );
                        });
                    }
                    if (item.type === 'shard') {
                        var skey = 'shard:' + entry.id;
                        return _enqueueApply(function () {
                            install.completedShards[entry.id] = { sha256: entry.sha256, size: entry.size };
                            return store.putFile(
                                { key: skey, packId: skey, gz: new Blob([buf], { type: 'application/gzip' }), raw: entry.raw },
                                install._track ? { key: 'install', value: install } : null
                            );
                        });
                    }
                    // Pack: parse + slice fully BEFORE the transaction opens.
                    var entries = store.parsePack(buf, _packKeyFn(entry));
                    return _enqueueApply(function () {
                        install.completedPacks[entry.id] = { hash: entry.hash, size: entry.size };
                        return store.applyPack(entry.id, entries,
                            install._track ? { key: 'install', value: install } : null);
                    });
                })
                .catch(function (err) {
                    // Up to MAX_ATTEMPTS per item on mismatch/network error,
                    // with a growing pause between them; roll back this item's
                    // progress bytes so the bar stays truthful.
                    if (item.type === 'core') delete install.completedCore[item.coreKey];
                    else if (item.type === 'shard') delete install.completedShards[entry.id];
                    else delete install.completedPacks[entry.id];
                    resetBytes();
                    // A full store cannot be retried into having room: the
                    // whole retry ladder would just re-download megabytes to
                    // fail at the very same IndexedDB write (field bug
                    // 2026-07-24, iPad: 69%→79%→69% forever). Fail fast and
                    // tag the error so the UI can say "free up space" and stop
                    // the automatic-resume loop.
                    var quota = _isQuotaError(err);
                    if (!quota && attempt < MAX_ATTEMPTS) {
                        return _delay(RETRY_DELAYS[attempt - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1])
                            .then(tryOnce);
                    }
                    // IDB DOMExceptions can carry an empty .message — fall back
                    // to .name so the surfaced diagnostic is never blank.
                    var werr = new Error('Download failed: ' + item.name + ' (' +
                        ((err && (err.message || err.name)) || err) + ')');
                    if (quota) werr.quota = true;
                    throw werr;
                });
        }
        return tryOnce();
    }

    /**
     * Build the outstanding work list for a manifest given resume state.
     * `langs` is the opt-in language selection (EN excluded); core is always
     * kept, EN packs are always kept, and a non-EN pack is kept only when its
     * language is in the selection. Sentence shards are opt-in — included only
     * when `includeShards` is true. doneBytes pre-counts already-completed
     * items (for the progress bar) but only for selected items.
     */
    function _buildWorkList(manifest, install, langs, includeShards) {
        var sel = _normLangs(langs);
        var work = [];
        var doneBytes = 0;
        CORE_KEYS.forEach(function (k) {
            var entry = manifest.core[k];
            if (!entry) return;
            var done = install.completedCore[k];
            if (done && done.hash === entry.hash) doneBytes += entry.size;
            else work.push({ type: 'core', coreKey: k, name: entry.path, entry: entry });
        });
        (manifest.packs || []).forEach(function (p) {
            if (!_packSelected(p, sel)) return;   // skip unselected languages
            var done = install.completedPacks[p.id];
            if (done && done.hash === p.hash) doneBytes += p.size;
            else work.push({ type: 'pack', name: p.id, entry: p });
        });
        if (includeShards) {
            (manifest.sentenceShards || []).forEach(function (s) {
                var done = install.completedShards[s.id];
                if (done && done.sha256 === s.sha256) doneBytes += s.size;
                else work.push({ type: 'shard', name: s.id, entry: s });
            });
        }
        return { work: work, doneBytes: doneBytes };
    }

    /**
     * First full install. Resumable: already-completed items (recorded in the
     * durable `install` state, hash-compared against the current manifest)
     * are skipped and pre-counted into the progress bar.
     * onProgress({ loadedBytes, totalBytes }) — throttled to ~10/s.
     */
    function firstInstall(onProgress, langs, includeShards) {
        var sel = _normLangs(langs);
        var wantShards = !!includeShards;
        // Ask for eviction protection BEFORE the first byte, not after the
        // last: a ~139 MB library written into a non-persistent origin can be
        // evicted by the phone halfway through the download. Fire-and-forget.
        store.requestPersist();
        return fetchManifest().then(function (manifest) {
            return store.getState('install').then(function (saved) {
                var install = saved || { completedCore: {}, completedPacks: {}, completedShards: {} };
                if (!install.completedShards) install.completedShards = {};
                // Record the selection ON the durable state, present in the
                // very first persisted snapshot: a later auto-resume (boot,
                // "online" event) must know WHICH languages and whether the
                // sentence shards were chosen, without asking the user again.
                install.langs = sel;
                install.shards = wantShards;
                install._track = true;   // commit install snapshots with each item
                var plan = _buildWorkList(manifest, install, sel, wantShards);
                var totalBytes = computeInstallBytes(manifest, sel, wantShards);
                var baseBytes = plan.doneBytes;
                var itemBytes = {};      // per-item received bytes (reset on retry)
                var failed = [];         // items that exhausted their attempts
                var lastEmit = 0;

                function emit(force) {
                    if (!onProgress) return;
                    var now = Date.now();
                    if (!force && now - lastEmit < 100) return; // ~10/s
                    lastEmit = now;
                    var loaded = baseBytes;
                    for (var k in itemBytes) loaded += itemBytes[k];
                    onProgress({ loadedBytes: Math.min(loaded, totalBytes), totalBytes: totalBytes });
                }

                // Preflight runs AFTER the work list so it can ask only for the
                // REMAINING bytes (see _storagePreflight), and the resume
                // record is persisted BEFORE the pool starts so that a crash
                // before the first item completes still leaves a resumable,
                // selection-carrying install state behind.
                return _storagePreflight(totalBytes - plan.doneBytes).then(function () {
                    return store.setState('install', install);
                }).then(function () {
                emit(true);
                return _runPool(plan.work, function (item) {
                    itemBytes[item.name] = 0;
                    return _processItem(
                        item, install,
                        function (n) { itemBytes[item.name] += n; emit(); },
                        function () { itemBytes[item.name] = 0; emit(true); }
                    ).then(function () {
                        // Fold the finished item into the base (exact size).
                        delete itemBytes[item.name];
                        baseBytes += item.entry.size;
                        emit(true);
                        // Cheap "the app can already open offline" flag: both
                        // core files present = meta DB + extras in IDB.
                        if (item.type === 'core' &&
                            install.completedCore.meta && install.completedCore.extras) {
                            return store.setState('coreReady', true).catch(function () {});
                        }
                    }).catch(function (err) {
                        // Failure tolerance (firstInstall ONLY): one bad pack
                        // must not throw away a 139 MB download. Record it and
                        // let the pool run to the end; the caller resumes the
                        // rest later. checkForUpdates/addLanguages keep their
                        // original abort-on-error behaviour.
                        delete itemBytes[item.name];
                        failed.push({
                            name: item.name,
                            error: String((err && err.message) || err),
                            quota: !!(err && err.quota)
                        });
                        emit(true);
                    });
                }, CONCURRENCY).then(function () {
                    emit(true);
                    if (failed.length > 0) {
                        // Do NOT write localManifest: checkForUpdates treats it
                        // as ground truth, so recording it over a library with
                        // holes would make those holes permanent. The `install`
                        // state stays in place so the next attempt resumes
                        // exactly the missing items.
                        var names = failed.map(function (f) { return f.name; }).join(', ');
                        var perr = new Error('Offline install incomplete: ' +
                            failed.length + ' item(s) failed (' + names + ')');
                        perr.partial = true;
                        perr.failedItems = failed;
                        perr.doneBytes = baseBytes;
                        perr.totalBytes = totalBytes;
                        // Any quota-failed item means the DEVICE is out of
                        // room — automatic retries would loop on the same
                        // write. The caller must tell the user the real cause.
                        for (var fi = 0; fi < failed.length; fi++) {
                            if (failed[fi].quota) { perr.quotaExceeded = true; break; }
                        }
                        throw perr;
                    }
                    // Success tail, committed as ONE transaction. Written as
                    // four separate transactions it had a half-finished window:
                    // a reload between them could leave `localManifest` stored
                    // with `install` never deleted (a stale resume record that
                    // lingers forever), or worse `localManifest` stored with
                    // `langs`/`shards` still missing — checkForUpdates then runs
                    // with an empty selection and shards opted out, and deletes
                    // every installed sentence shard. Atomic now: the install is
                    // either fully complete or fully resumable, never half.
                    //  - localManifest must reflect what was actually installed:
                    //    when shards are opted out, strip them so the delta
                    //    check never treats the (never-downloaded) shards as
                    //    present. Runtime shard search reads the LIVE manifest
                    //    (db.js), not this stored copy, so this is safe.
                    //  - langs: the installed opt-in language selection, so
                    //    delta updates and "add a language later" know what to
                    //    maintain.
                    //  - shards: the shard opt-in choice, so delta updates know
                    //    whether to keep the sentence shards fresh.
                    return store.commitState({
                        localManifest: _manifestForStore(manifest, wantShards),
                        langs: sel,
                        shards: wantShards
                    }, ['install']);
                }).then(function () {
                    return manifest;
                });
                });   // close _storagePreflight().then(setState('install')).then(...)
            });
        });
    }

    /**
     * Durable resume state of an interrupted first install, or null when there
     * is none. `langs`/`shards` are the selection recorded at install START
     * (see firstInstall), so the boot path can continue exactly what the user
     * originally chose without asking again.
     */
    function getResumeState() {
        return store.getState('install').then(function (install) {
            if (!install) return null;
            return {
                install: install,
                langs: install.langs || [],
                shards: !!install.shards
            };
        });
    }

    /**
     * Is the CORE of the library ('core:meta' + 'core:extras') on the device?
     * When it is, the app can open fully offline even though packs are still
     * missing — individual transcripts fall back to the network when online.
     * Implemented as a cheap state flag written by firstInstall as soon as
     * both core items commit; the getGz() probe is only a FALLBACK for
     * libraries installed before the flag existed, because getGz reads the
     * whole (~34 MB) stored blob into memory and is far too heavy to run on
     * every boot.
     */
    function isCoreReady() {
        return store.getState('coreReady').then(function (flag) {
            if (flag) return true;
            return store.getGz('core:meta').then(function (meta) {
                if (!meta) return false;
                return store.getGz('core:extras').then(function (extras) { return !!extras; });
            });
        }).catch(function () { return false; });
    }

    /**
     * Delta update: remote manifest vs stored localManifest. Downloads and
     * applies every changed core file and changed/new pack, deletes packs that
     * were removed from the manifest, and ONLY THEN advances localManifest
     * (fence: a partial update never claims to be current). Never throws —
     * returns { changedItems, coreChanged } or { changedItems: 0, error }.
     */
    function checkForUpdates() {
        // One flag per core key (derived, so a new core file cannot be
        // forgotten here). Consumers read individual keys (app.js reads
        // .meta / .extras), so extra keys are additive and break nothing.
        var coreChanged = {};
        CORE_KEYS.forEach(function (k) { coreChanged[k] = false; });
        return fetchManifest().then(function (remote) {
            return store.getState('localManifest').then(function (local) {
                if (!local) return { changedItems: 0, coreChanged: coreChanged };
                return store.getState('langs').then(function (savedLangs) {
                return store.getState('shards').then(function (savedShards) {
                var sel = _normLangs(savedLangs);
                var includeShards = !!savedShards;

                var changedItems = 0;
                var work = [];
                CORE_KEYS.forEach(function (k) {
                    var re = remote.core[k];
                    var lo = local.core && local.core[k];
                    if (re && (!lo || lo.hash !== re.hash)) {
                        coreChanged[k] = true;
                        changedItems += 1;
                        work.push({ type: 'core', coreKey: k, name: re.path, entry: re });
                    }
                });
                var remoteIds = {};
                (remote.packs || []).forEach(function (p) { if (_packSelected(p, sel)) remoteIds[p.id] = true; });
                var localById = {};
                (local.packs || []).forEach(function (p) { localById[p.id] = p; });
                (remote.packs || []).forEach(function (p) {
                    if (!_packSelected(p, sel)) return;   // never pull unselected languages
                    var lo = localById[p.id];
                    if (!lo || lo.hash !== p.hash) {
                        changedItems += (p.count || 1);
                        work.push({ type: 'pack', name: p.id, entry: p });
                    }
                });
                // Packs removed from the manifest (within the selected set) →
                // delete their members. Unselected-language packs that were
                // never installed are ignored.
                var removed = (local.packs || []).filter(function (p) {
                    return _packSelected(p, sel) && !remoteIds[p.id];
                });
                removed.forEach(function (p) { changedItems += (p.count || 1); });

                // Sentence shards are OPT-IN (offline text search). Only sync
                // them when the install chose them (persisted `shards` flag).
                // When opted in: detect updated/new shards (sha256 compare) and
                // shards dropped from the manifest. When opted out: any shards
                // still recorded in localManifest (e.g. a prior opted-in install
                // whose flag was later turned off) are treated as removed.
                var removedShards = [];
                if (includeShards) {
                    var remoteShardIds = {};
                    (remote.sentenceShards || []).forEach(function (s) { remoteShardIds[s.id] = true; });
                    var localShardById = {};
                    (local.sentenceShards || []).forEach(function (s) { localShardById[s.id] = s; });
                    (remote.sentenceShards || []).forEach(function (s) {
                        var lo = localShardById[s.id];
                        if (!lo || lo.sha256 !== s.sha256) {
                            changedItems += 1;
                            work.push({ type: 'shard', name: s.id, entry: s });
                        }
                    });
                    removedShards = (local.sentenceShards || []).filter(function (s) {
                        return !remoteShardIds[s.id];
                    });
                } else {
                    // Opted out — remove every locally recorded shard.
                    removedShards = (local.sentenceShards || []).slice();
                }
                removedShards.forEach(function () { changedItems += 1; });

                if (changedItems === 0) return { changedItems: 0, coreChanged: coreChanged };

                // Updates share the install-state shape but do NOT track
                // durable resume state (no _track) — a failed delta simply
                // re-runs next time against the unchanged localManifest.
                var install = { completedCore: {}, completedPacks: {}, completedShards: {} };
                return _runPool(work, function (item) {
                    return _processItem(item, install, null, function () {});
                }, CONCURRENCY).then(function () {
                    return _runPool(removed, function (p) {
                        return _enqueueApply(function () { return store.applyPack(p.id, []); });
                    }, 1);
                }).then(function () {
                    // Delete removed shards. A shard is stored as a single file
                    // record whose byPack index == its 'shard:<id>' key, so the
                    // existing applyPack(packId, []) primitive removes exactly it.
                    return _runPool(removedShards, function (s) {
                        return _enqueueApply(function () { return store.applyPack('shard:' + s.id, []); });
                    }, 1);
                }).then(function () {
                    // Fence: everything applied and verified — only now
                    // advance the local manifest. Keep the stored copy honest
                    // about shards (empty when opted out) so the next delta
                    // check matches what is actually in IDB.
                    return store.setState('localManifest', _manifestForStore(remote, includeShards));
                }).then(function () {
                    return { changedItems: changedItems, coreChanged: coreChanged };
                });
                });   // close store.getState('shards').then(savedShards)
                });   // close store.getState('langs').then(savedLangs)
            });
        }).catch(function (err) {
            console.warn('Offline update check failed:', err);
            return { changedItems: 0, coreChanged: coreChanged, error: err };
        });
    }

    /**
     * Get the persisted opt-in language selection (EN excluded). [] when the
     * library is not installed or nothing extra was selected.
     */
    function getInstalledLangs() {
        return store.getState('langs').then(function (v) { return _normLangs(v); });
    }

    /**
     * Add one or more languages to an already-installed library: download and
     * apply ONLY those languages' packs (core and EN are already present), then
     * fold them into the persisted selection so delta updates keep them fresh.
     * `langsToAdd` is an opt-in list (EN ignored). onProgress({loadedBytes,
     * totalBytes}) mirrors firstInstall. Never re-downloads core or EN.
     */
    function addLanguages(langsToAdd, onProgress) {
        var add = _normLangs(langsToAdd);
        if (add.length === 0) return Promise.resolve({ added: [] });
        return fetchManifest().then(function (manifest) {
            var work = [];
            var totalBytes = 0;
            (manifest.packs || []).forEach(function (p) {
                if (add.indexOf(p.lang) !== -1) {
                    work.push({ type: 'pack', name: p.id, entry: p });
                    totalBytes += (p.size || 0);
                }
            });
            var install = { completedCore: {}, completedPacks: {}, completedShards: {} };
            var baseBytes = 0;
            var itemBytes = {};
            var lastEmit = 0;
            function emit(force) {
                if (!onProgress) return;
                var now = Date.now();
                if (!force && now - lastEmit < 100) return;
                lastEmit = now;
                var loaded = baseBytes;
                for (var k in itemBytes) loaded += itemBytes[k];
                onProgress({ loadedBytes: Math.min(loaded, totalBytes), totalBytes: totalBytes });
            }
            emit(true);
            return _runPool(work, function (item) {
                itemBytes[item.name] = 0;
                return _processItem(
                    item, install,
                    function (n) { itemBytes[item.name] += n; emit(); },
                    function () { itemBytes[item.name] = 0; emit(true); }
                ).then(function () {
                    delete itemBytes[item.name];
                    baseBytes += item.entry.size;
                    emit(true);
                });
            }, CONCURRENCY).then(function () {
                emit(true);
                return getInstalledLangs();
            }).then(function (cur) {
                var merged = cur.slice();
                add.forEach(function (l) { if (merged.indexOf(l) === -1) merged.push(l); });
                return store.setState('langs', merged).then(function () {
                    return { added: add, langs: merged };
                });
            });
        });
    }

    /**
     * Add the sentence shards (offline text search, ~200 MB) to an ALREADY
     * installed library that opted out of them at install time. Mirrors
     * addLanguages(): downloads + applies only the shards (core/EN/other
     * languages are already present), then persists `shards: true` and folds
     * the shard list into `localManifest` so checkForUpdates' delta logic
     * treats them as present from now on (see _manifestForStore(manifest,
     * true) — same shape, built here without re-fetching the manifest twice).
     * onProgress({loadedBytes, totalBytes}) mirrors addLanguages.
     */
    function addShards(onProgress) {
        return fetchManifest().then(function (manifest) {
            var work = [];
            var totalBytes = 0;
            (manifest.sentenceShards || []).forEach(function (s) {
                if (s) { work.push({ type: 'shard', name: s.id, entry: s }); totalBytes += (s.size || 0); }
            });
            if (work.length === 0) {
                return store.setState('shards', true).then(function () { return { added: true }; });
            }
            var install = { completedCore: {}, completedPacks: {}, completedShards: {} };
            var baseBytes = 0;
            var itemBytes = {};
            var lastEmit = 0;
            function emit(force) {
                if (!onProgress) return;
                var now = Date.now();
                if (!force && now - lastEmit < 100) return;
                lastEmit = now;
                var loaded = baseBytes;
                for (var k in itemBytes) loaded += itemBytes[k];
                onProgress({ loadedBytes: Math.min(loaded, totalBytes), totalBytes: totalBytes });
            }
            emit(true);
            return _runPool(work, function (item) {
                itemBytes[item.name] = 0;
                return _processItem(
                    item, install,
                    function (n) { itemBytes[item.name] += n; emit(); },
                    function () { itemBytes[item.name] = 0; emit(true); }
                ).then(function () {
                    delete itemBytes[item.name];
                    baseBytes += item.entry.size;
                    emit(true);
                });
            }, CONCURRENCY).then(function () {
                emit(true);
                return store.getState('localManifest').then(function (lm) {
                    var updated = {};
                    if (lm) Object.keys(lm).forEach(function (k) { updated[k] = lm[k]; });
                    updated.sentenceShards = manifest.sentenceShards || [];
                    return store.commitState({ shards: true, localManifest: updated }, []);
                });
            }).then(function () {
                return { added: true };
            });
        });
    }

    return {
        fetchManifest: fetchManifest,
        firstInstall: firstInstall,
        checkForUpdates: checkForUpdates,
        computeInstallBytes: computeInstallBytes,
        getInstalledLangs: getInstalledLangs,
        addLanguages: addLanguages,
        addShards: addShards,
        getResumeState: getResumeState,
        isCoreReady: isCoreReady
    };
})();
