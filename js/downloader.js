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
    // Core files that every install downloads: the meta DB and the
    // summaries / essence extras.
    //
    // `sentences` — the whole-file EN sentence DB, 18.9 MB packed — was in this
    // list until 2026-07-27 and is NOT any more, because nothing ever read it.
    // Both transcript-text search paths in app.js go through
    // db.searchSentencesChunked(), i.e. the SHARDS; db.js's whole-file
    // loadSentencesDB() had zero callers, so every install on every device paid
    // 18.9 MB for a blob it never opened once. The sentence SHARDS are a
    // separate, opt-in manifest section (`sentenceShards`) and are untouched.
    //
    // Dropping a key from this list is only HALF the job. This loop-driven list
    // is deliberately NOT what reclaims the bytes from devices that already
    // installed the file — see the "core files dropped from the manifest" block
    // in checkForUpdates, which walks localManifest instead. Removing a key
    // here without that block would strand the blob in IndexedDB forever.
    //
    // NOTE: the tiered-readiness gate (coreReady / isCoreReady) has always
    // waited only for meta+extras, so it is unaffected by this.
    var CORE_KEYS = ['meta', 'extras'];
    // Per-item attempts and the pause before each retry. Mobile networks fail
    // in bursts (tunnel, lift, cell handover) — an immediate second try tends
    // to fail for the same reason, so back off before giving the item up.
    var MAX_ATTEMPTS = 4;
    var RETRY_DELAYS = [1000, 4000, 10000];

    /* ---- "A delta is rewriting the sentence shards right now" --------------
     * Read by db.js. During that window the shards in IndexedDB and the shard
     * list recorded in `localManifest` legitimately disagree — the shards are
     * being replaced one by one and `localManifest` only advances at the very
     * end (that fence is deliberate: an interrupted delta must leave the
     * PREVIOUS healthy generation, never a half-and-half mixture). Without this
     * flag a search landing in that window either accuses a healthy library of
     * being damaged or, worse, quietly returns results missing whatever shards
     * this delta adds.
     *
     * A PLAIN VARIABLE, not an IndexedDB record, on purpose:
     *   - a crashed / reloaded / killed session starts with it false, so it can
     *     never wedge the app permanently into "updating". A persisted flag
     *     would need a timestamp plus a startup sweep to get the same property,
     *     and getting THAT wrong is a worse failure than the one it guards.
     * A counter, not a boolean: overlapping calls must not release each other.
     *
     * CROSS-TAB (BroadcastChannel). The app checks for updates on load, so
     * opening a second tab can start a delta while the user is mid-search in the
     * first — which would show the first tab the false "damaged" message this
     * whole pass removes. BroadcastChannel is the right mechanism precisely
     * because it STORES NOTHING: it covers the other tabs without giving up the
     * property P26 guards (the flag cannot outlive the session).
     *
     * Death of an updating tab is handled by heartbeat, not by trust: an
     * updating tab pings every SHARD_UPDATE_PING_MS, and a listener forgets any
     * tab it has not heard from for SHARD_UPDATE_STALE_MS. A tab that dies
     * mid-delta therefore expires on its own within a few seconds instead of
     * freezing every other tab forever. A tab opened mid-delta asks 'who' and
     * every updating tab answers, so it does not have to wait for the next beat.
     *
     * No BroadcastChannel (older browsers, some webviews) → _bc stays null,
     * _remoteUpdaters stays empty, and behaviour degrades exactly to the
     * single-tab version above. Never worse than before.
     */
    var SHARD_UPDATE_PING_MS = 2000;    // heartbeat while THIS tab is updating
    var SHARD_UPDATE_STALE_MS = 6000;   // 3 missed beats → assume that tab died

    var _shardUpdateDepth = 0;
    var _remoteUpdaters = {};           // other tabs' id → last time we heard from it
    var _pingTimer = null;
    var _tabId = 'tab-' + Math.random().toString(36).slice(2) + '-' + Date.now();
    var _bc = null;
    try {
        if (typeof BroadcastChannel !== 'undefined') _bc = new BroadcastChannel('ppp-shard-update');
    } catch (e) { _bc = null; }

    function _bcPost(type) {
        try { if (_bc) _bc.postMessage({ t: type, id: _tabId }); } catch (e) { /* channel closed */ }
    }

    /** Drop tabs we have not heard from within the stale window — this is what
     *  makes a tab that died mid-delta stop blocking everyone else. */
    function _anyRemoteUpdating() {
        var now = Date.now(), alive = false, id;
        for (id in _remoteUpdaters) {
            if (now - _remoteUpdaters[id] > SHARD_UPDATE_STALE_MS) delete _remoteUpdaters[id];
            else alive = true;
        }
        return alive;
    }

    if (_bc) {
        _bc.onmessage = function (ev) {
            var m = ev && ev.data;
            if (!m || !m.id || m.id === _tabId) return;
            if (m.t === 'start' || m.t === 'alive') _remoteUpdaters[m.id] = Date.now();
            else if (m.t === 'end') delete _remoteUpdaters[m.id];
            else if (m.t === 'who' && _shardUpdateDepth > 0) _bcPost('alive');
        };
        _bcPost('who');   // opened mid-delta? ask now instead of waiting a beat
        // Best-effort courtesy so other tabs recover instantly rather than after
        // the stale window. The heartbeat is what actually guarantees it — this
        // event is not delivered reliably on a crash or a killed process.
        try {
            window.addEventListener('pagehide', function () {
                if (_shardUpdateDepth > 0) _bcPost('end');
            });
        } catch (e) { /* no window listener — heartbeat still covers it */ }
    }

    function isUpdatingShards() {
        return _shardUpdateDepth > 0 || _anyRemoteUpdating();
    }

    function _raiseShardUpdate() {
        _shardUpdateDepth++;
        if (_shardUpdateDepth !== 1) return;
        _bcPost('start');
        if (!_pingTimer) {
            _pingTimer = setInterval(function () { _bcPost('alive'); }, SHARD_UPDATE_PING_MS);
        }
    }

    function _lowerShardUpdate() {
        if (_shardUpdateDepth === 0) return;
        _shardUpdateDepth--;
        if (_shardUpdateDepth !== 0) return;
        if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; }
        _bcPost('end');
    }

    /* ---- Cancellation -----------------------------------------------------
     * The two gated entry points (firstInstall, addShards) take an optional
     * `signal` as their LAST argument. It is either a real
     * AbortSignal — then fetch() itself is cancelled mid-flight — or any object
     * with an `aborted` property, which the pool and the retry ladder poll.
     * Without this, a caller that gave up on the promise (the app's stall
     * watchdog) left the whole pool running: a second attempt then downloaded
     * the same 342 MB in parallel and both wrote install snapshots into the
     * same IndexedDB record (Fable review, 2026-07-27).
     */
    function _abortError() {
        var e = new Error('Install cancelled');
        e.aborted = true;
        return e;
    }

    function _isAborted(signal) {
        return !!(signal && signal.aborted);
    }

    function _isAbortErr(err) {
        return !!(err && (err.aborted === true || err.name === 'AbortError'));
    }

    /** Only a real AbortSignal may be handed to fetch(); the polled fallback
     *  object would make fetch() throw TypeError. */
    function _fetchSignal(signal) {
        return (signal && typeof signal.addEventListener === 'function') ? signal : null;
    }

    /** Sleep that wakes up early when the install is cancelled — otherwise a
     *  cancel during the 10 s retry back-off would sit there doing nothing. */
    function _delay(ms, signal) {
        return new Promise(function (resolve, reject) {
            var fired = false;
            var timer = null;
            function done() {
                if (fired) return;
                fired = true;
                if (timer) clearTimeout(timer);
                if (_isAborted(signal)) reject(_abortError());
                else resolve();
            }
            timer = setTimeout(done, ms);
            var s = _fetchSignal(signal);
            if (s) { try { s.addEventListener('abort', done); } catch (e) {} }
        });
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

    function fetchManifest(signal) {
        var opts = { cache: 'no-store' };
        var s = _fetchSignal(signal);
        if (s) opts.signal = s;
        return fetch('data/manifest.json', opts).then(function (r) {
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
    function _fetchWithProgress(url, onBytes, signal) {
        if (_isAborted(signal)) return Promise.reject(_abortError());
        var opts = { cache: 'no-store' };
        var fs = _fetchSignal(signal);
        if (fs) opts.signal = fs;
        return fetch(url, opts).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' loading ' + url);
            if (!r.body || !r.body.getReader) {
                return r.arrayBuffer().then(function (buf) {
                    if (_isAborted(signal)) throw _abortError();
                    if (onBytes) onBytes(buf.byteLength);
                    return buf;
                });
            }
            var reader = r.body.getReader();
            var chunks = [];
            var received = 0;
            function pump() {
                // Polled cancellation: covers the browsers without a real
                // AbortSignal, where fetch() cannot be killed but the read loop
                // can still stop instead of pulling the whole file.
                if (_isAborted(signal)) {
                    try { reader.cancel(); } catch (e) {}
                    return Promise.reject(_abortError());
                }
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
     *
     * Two guarantees the callers depend on:
     *  - When `signal` is aborted, no further item is STARTED; the runners drain
     *    (each in-flight item ends quickly, its fetch having been cancelled).
     *  - The returned promise settles only after EVERY runner has stopped, so
     *    "the pool finished" really means nothing is still downloading. It used
     *    to reject the moment one item failed while the other runner kept
     *    pulling items behind the caller's back — the caller then believed the
     *    job had stopped and started a second one.
     */
    function _runPool(items, worker, concurrency, signal) {
        var idx = 0;
        var firstErr = null;
        function next() {
            if (firstErr || _isAborted(signal)) return Promise.resolve();
            if (idx >= items.length) return Promise.resolve();
            var item = items[idx++];
            return worker(item).then(next, function (err) {
                if (!firstErr) firstErr = err;
            });
        }
        var runners = [];
        for (var k = 0; k < Math.min(concurrency, items.length); k++) runners.push(next());
        return Promise.all(runners).then(function () {
            if (firstErr) throw firstErr;
        });
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
    function _processItem(item, install, onBytes, resetBytes, signal) {
        var entry = item.entry;
        var attempt = 0;
        function tryOnce() {
            if (_isAborted(signal)) return Promise.reject(_abortError());
            attempt++;
            return _fetchWithProgress(_itemUrl(entry), onBytes, signal)
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
                    // Cancelled: never retry, never dress it up as a download
                    // failure. The caller is stopping this install on purpose
                    // and the durable resume state stays exactly as it is.
                    if (_isAborted(signal) || _isAbortErr(err)) throw _abortError();
                    // A full store cannot be retried into having room: the
                    // whole retry ladder would just re-download megabytes to
                    // fail at the very same IndexedDB write (field bug
                    // 2026-07-24, iPad: 69%→79%→69% forever). Fail fast and
                    // tag the error so the UI can say "free up space" and stop
                    // the automatic-resume loop.
                    var quota = _isQuotaError(err);
                    if (!quota && attempt < MAX_ATTEMPTS) {
                        return _delay(RETRY_DELAYS[attempt - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1], signal)
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
     * `signal` (optional, last) cancels the whole install: fetches are aborted,
     * no further item is started, and NOTHING is committed — the durable resume
     * state is left exactly as the last completed item wrote it, so the next
     * attempt continues instead of starting over.
     */
    function firstInstall(onProgress, langs, includeShards, signal) {
        if (_isAborted(signal)) return Promise.reject(_abortError());
        var sel = _normLangs(langs);
        var wantShards = !!includeShards;
        // Ask for eviction protection BEFORE the first byte, not after the
        // last: a ~139 MB library written into a non-persistent origin can be
        // evicted by the phone halfway through the download. Fire-and-forget.
        store.requestPersist();
        return fetchManifest(signal).then(function (manifest) {
            if (_isAborted(signal)) throw _abortError();
            return store.getState('install').then(function (saved) {
                if (_isAborted(signal)) throw _abortError();
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
                if (_isAborted(signal)) throw _abortError();
                emit(true);
                return _runPool(plan.work, function (item) {
                    itemBytes[item.name] = 0;
                    return _processItem(
                        item, install,
                        function (n) { itemBytes[item.name] += n; emit(); },
                        function () { itemBytes[item.name] = 0; emit(true); },
                        signal
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
                        // A cancellation is not a failed item — recording it
                        // would turn a deliberate stop into a permanent
                        // "this pack is broken" report.
                        if (_isAbortErr(err)) return;
                        failed.push({
                            name: item.name,
                            error: String((err && err.message) || err),
                            quota: !!(err && err.quota)
                        });
                        emit(true);
                    });
                }, CONCURRENCY, signal).then(function () {
                    emit(true);
                    // Cancelled mid-pool: every runner has stopped by now (see
                    // _runPool), so it is safe for the caller to start again.
                    // Commit nothing — localManifest here would fence a library
                    // that is only partly on the device.
                    if (_isAborted(signal)) throw _abortError();
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
                    //    present. Safe for runtime search too: since A7 the
                    //    chunked search reads THIS copy only when the shards are
                    //    installed (state 'shards' === true); an opted-out
                    //    device never consults the emptied list and keeps
                    //    reading the live manifest (db.js _getSentenceShards).
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
                // Core files DROPPED from the manifest → delete them from this
                // device. The loop above cannot do this and never could: it
                // walks CORE_KEYS and reads only `remote.core[k]`, so a key that
                // VANISHES from the remote manifest leaves `re === undefined`
                // and nothing happens at all. Once the key also leaves
                // CORE_KEYS (as `sentences` did) the loop does not even look at
                // it. Packs and shards have had a removal path since they were
                // written (`removed` / `removedShards` below); core had none,
                // so an 18.9 MB blob no server publishes any more would sit in
                // IndexedDB on every already-installed device forever.
                //
                // So iterate the LOCAL core keys, not CORE_KEYS: localManifest
                // is the authority on what is ON this device, the remote
                // manifest on what SHOULD be. Keys still published remotely are
                // handled by the loop above and never reach here (remoteCore[k]
                // is truthy for them) — including core keys this build has
                // never heard of, which are left strictly alone.
                //
                // The `CORE_KEYS.indexOf(k) === -1` guard: a key this build
                // still declares mandatory is NEVER deleted, however the remote
                // manifest looks. fetchManifest does no schema validation, so a
                // truncated-but-HTTP-200 manifest.json would otherwise wipe the
                // meta DB off every device at once. A key can only be reclaimed
                // when BOTH sides agree it is gone.
                var removedCore = [];
                var remoteCore = remote.core || {};
                Object.keys(local.core || {}).forEach(function (k) {
                    if (!remoteCore[k] && CORE_KEYS.indexOf(k) === -1) removedCore.push(k);
                });
                changedItems += removedCore.length;

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

                // Raise the "shards are being rewritten" flag — but ONLY when
                // this delta actually touches shards, and only from the moment
                // the first byte is about to be applied.
                //  - Raising it at function entry would make every no-op boot
                //    check briefly declare "updating" and blank a search that
                //    started in that window, while IndexedDB was in fact
                //    untouched and the search would have been correct.
                //  - Raising it for a packs-only delta (transcripts, minutes
                //    long) would pause sentence search over a change that
                //    cannot affect a single shard.
                var touchesShards = removedShards.length > 0 || work.some(function (w) {
                    return w.type === 'shard';
                });
                if (touchesShards) _raiseShardUpdate();
                var _released = false;
                function _releaseShardUpdate() {
                    if (touchesShards && !_released) { _released = true; _lowerShardUpdate(); }
                }

                // Updates share the install-state shape but do NOT track
                // durable resume state (no _track) — a failed delta simply
                // re-runs next time against the unchanged localManifest.
                var install = { completedCore: {}, completedPacks: {}, completedShards: {} };
                // Started from an already-resolved promise so that even a
                // SYNCHRONOUS throw out of _runPool becomes a rejection this
                // chain's handler sees. Thrown straight out of the `return`
                // instead, it would skip the release below and leave the app
                // reporting "updating" for the rest of the session.
                return Promise.resolve().then(function () {
                    return _runPool(work, function (item) {
                        return _processItem(item, install, null, function () {});
                    }, CONCURRENCY);
                }).then(function () {
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
                    // Delete core files dropped from the manifest. A core file
                    // is stored as a SINGLE record whose byPack index equals its
                    // own 'core:<key>' key (see _processItem), exactly like a
                    // shard — so the same applyPack(packId, []) primitive that
                    // removes packs and shards removes precisely this one record
                    // and nothing else. No new primitive is needed.
                    return _runPool(removedCore, function (k) {
                        return _enqueueApply(function () { return store.applyPack('core:' + k, []); });
                    }, 1);
                }).then(function () {
                    // Fence: everything applied and verified — only now
                    // advance the local manifest. Keep the stored copy honest
                    // about shards (empty when opted out) so the next delta
                    // check matches what is actually in IDB.
                    // This write is ALSO the second half of the core removal:
                    // localManifest becomes the remote manifest, which no longer
                    // carries the dropped key, so `local.core` stops claiming a
                    // file that is no longer in IndexedDB. Nothing extra to do —
                    // but it does mean the delete above must happen BEFORE this
                    // line, or a crash in between would lose the only record of
                    // what still needs deleting.
                    return store.setState('localManifest', _manifestForStore(remote, includeShards));
                }).then(function () {
                    // Lowered only AFTER localManifest advanced: that write IS
                    // the moment the shards and the recorded list agree again.
                    _releaseShardUpdate();
                    return { changedItems: changedItems, coreChanged: coreChanged };
                }, function (err) {
                    // Stand-in for `finally` (not in this file's ES5 baseline).
                    // A thrown delta must not leave the app stuck in "updating"
                    // — the outer .catch below would otherwise swallow the
                    // error and the flag with it.
                    _releaseShardUpdate();
                    throw err;
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
     * onProgress({loadedBytes, totalBytes}) mirrors addLanguages. `signal`
     * (optional, last) cancels it exactly like firstInstall: fetches aborted,
     * no further item started, `shards: true` NOT committed.
     */
    function addShards(onProgress, signal) {
        if (_isAborted(signal)) return Promise.reject(_abortError());
        return fetchManifest(signal).then(function (manifest) {
            if (_isAborted(signal)) throw _abortError();
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
                    function () { itemBytes[item.name] = 0; emit(true); },
                    signal
                ).then(function () {
                    delete itemBytes[item.name];
                    baseBytes += item.entry.size;
                    emit(true);
                });
            }, CONCURRENCY, signal).then(function () {
                emit(true);
                if (_isAborted(signal)) throw _abortError();
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
        isUpdatingShards: isUpdatingShards,
        getResumeState: getResumeState,
        isCoreReady: isCoreReady
    };
})();
