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

    /* ---- The DELTA claim: one download at a time across tabs ---------------
     * (Codex MEDIUM-1, 2026-07-28.) The app checks for updates on load, so two
     * tabs opened on a new generation each started their own delta and the
     * device paid for the same ~240 MB twice. Correctness was never at risk —
     * the fence is atomic and every item is verified — but the bytes are the
     * entire subject of this change.
     *
     * It rides the SAME BroadcastChannel ('ppp-shard-update') and the same
     * heartbeat design as the shard flag above; only the message vocabulary is
     * extended ('dstart' / 'dalive' / 'dend' / 'dwho'). Tabs running an older
     * build ignore types they do not know, and so does the handler below, so
     * mixing builds degrades to the previous behaviour rather than breaking.
     *
     * It is a SEPARATE claim rather than a reuse of _raiseShardUpdate() because
     * that flag means "the sentence shards are being rewritten" and pauses text
     * search. Raising it for a packs-only delta would pause search over a change
     * that cannot touch a single shard — explicitly rejected where the flag is
     * raised in checkForUpdates. Two claims, one channel, one heartbeat design.
     *
     * Same crash property as the shard flag: a plain variable plus a heartbeat,
     * so a tab that dies mid-delta stops blocking the others within
     * SHARD_UPDATE_STALE_MS instead of wedging them forever.
     */
    var _deltaClaimDepth = 0;
    var _remoteDeltas = {};
    var _deltaPingTimer = null;

    /** Is ANOTHER tab downloading a delta right now? (Stale tabs swept out.) */
    function isDeltaRunningElsewhere() {
        var now = Date.now(), alive = false, id;
        for (id in _remoteDeltas) {
            if (now - _remoteDeltas[id] > SHARD_UPDATE_STALE_MS) delete _remoteDeltas[id];
            else alive = true;
        }
        return alive;
    }

    function _raiseDeltaClaim() {
        _deltaClaimDepth++;
        if (_deltaClaimDepth !== 1) return;
        _bcPost('dstart');
        if (!_deltaPingTimer) {
            _deltaPingTimer = setInterval(function () { _bcPost('dalive'); }, SHARD_UPDATE_PING_MS);
        }
    }

    function _lowerDeltaClaim() {
        if (_deltaClaimDepth === 0) return;
        _deltaClaimDepth--;
        if (_deltaClaimDepth !== 0) return;
        if (_deltaPingTimer) { clearInterval(_deltaPingTimer); _deltaPingTimer = null; }
        _bcPost('dend');
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
            else if (m.t === 'dstart' || m.t === 'dalive') _remoteDeltas[m.id] = Date.now();
            else if (m.t === 'dend') delete _remoteDeltas[m.id];
            else if (m.t === 'dwho' && _deltaClaimDepth > 0) _bcPost('dalive');
        };
        _bcPost('who');   // opened mid-delta? ask now instead of waiting a beat
        _bcPost('dwho');  // ...and the same question about the delta claim
        // Best-effort courtesy so other tabs recover instantly rather than after
        // the stale window. The heartbeat is what actually guarantees it — this
        // event is not delivered reliably on a crash or a killed process.
        try {
            window.addEventListener('pagehide', function () {
                if (_shardUpdateDepth > 0) _bcPost('end');
                if (_deltaClaimDepth > 0) _bcPost('dend');
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

    /** Thrown when a caller asked to touch the sentence shards while another
     *  shard-touching operation already holds the isUpdatingShards() flag —
     *  see addShards()'s use of it below (Codex HIGH-1, 2026-07-28). */
    function _libraryUpdatingError() {
        var e = new Error('Sentence shards are already being synced — try again in a moment');
        e.libraryUpdating = true;
        return e;
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
        return fetch(PPP.dataUrl('data/manifest.json'), opts).then(function (r) {
            if (!r.ok) throw new Error('manifest HTTP ' + r.status);
            return r.json();
        });
    }

    /** Length of a manifest list section, 0 for missing/not-a-list. */
    function _sectionCount(mf, key) {
        var v = mf && mf[key];
        return (v && typeof v.length === 'number') ? v.length : 0;
    }

    /**
     * Would acting on this remote manifest be a mass deletion that no real
     * release could have produced? Returns a description (with the counts) when
     * the manifest must be refused, or null when the delta may proceed.
     *
     * WHY THIS EXISTS. fetchManifest validates nothing past HTTP 200 +
     * JSON.parse, and checkForUpdates reads "recorded locally, absent remotely"
     * as "delete it" — that IS the delta, and packs/shards have had that path
     * since they were written. So a manifest whose `packs` or `sentenceShards`
     * arrives EMPTY — a build script that published the skeleton before the
     * arrays were filled, a half-finished deploy, a manifest generated from a
     * query that came back with nothing — is read as "the server removed every
     * pack and every shard" and costs the device ~200 MB it must then pull
     * again, on exactly the metered connections the rest of this work protects.
     * Recoverable, but expensive, and triggered by a file nobody inspected.
     *
     * WHY THE THRESHOLD IS "THE WHOLE SECTION" AND NOT A PERCENTAGE. The guard
     * must not make legitimate removal impossible: B3 drops a core key on
     * purpose, and a pack or a shard may be retired later for good reasons.
     * Any NON-ZERO remote count is a shape a real release can have — dropping
     * one of two packs is a 50 % fall — so any ratio threshold would sooner or
     * later refuse a genuine release, which is the failure this guard is not
     * allowed to introduce. Zero is the one count no real release produces:
     * the packs ARE the library, so a manifest offering none of them does not
     * describe any version of this app. Hence the narrowest rule that still
     * catches the wipe: refuse only when a section this device records as
     * non-empty comes back with nothing at all. 100 packs -> 99 still deletes
     * one; 100 -> 0 is refused.
     *
     * WHY IT COMPARES AGAINST localManifest AND NOT AGAINST "EMPTY IS BAD".
     * An empty array is a legitimate state, never evidence on its own: a user
     * who installed English only never held the LV/RU packs, and an install
     * that opted out of sentence search records `sentenceShards: []`
     * (_manifestForStore). For those devices empty is simply empty on both
     * sides and the guard stays silent. Only local-says-N / remote-says-0 is
     * suspicious.
     *
     * `core` is deliberately NOT checked here. It already has a stronger,
     * narrower guard — CORE_KEYS, see checkForUpdates and P14f — which keeps
     * every mandatory file whatever the manifest says while still allowing a
     * key this build has dropped to be reclaimed from a `core: {}` manifest.
     * An emptiness check on top would only block that reclaim.
     *
     * Lives next to fetchManifest because its subject is the fetched document,
     * but is CALLED from checkForUpdates: the comparison needs localManifest,
     * which fetchManifest has no business reading on every call, and
     * checkForUpdates is the only caller that deletes anything. The size
     * estimates and offer panels in app.js must not start failing over this.
     */
    function _manifestWipesSection(remote, local) {
        var bad = [];
        [['packs', 'pack'], ['sentenceShards', 'sentence shard']].forEach(function (sec) {
            var localN = _sectionCount(local, sec[0]);
            var remoteN = _sectionCount(remote, sec[0]);
            if (localN > 0 && remoteN === 0) {
                bad.push(sec[1] + ' (local ' + localN + ', remote ' + remoteN + ')');
            }
        });
        return bad.length ? bad.join('; ') : null;
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
        return PPP.dataUrl(item.path) + '?v=' + v;
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

    /** Blob MIME for a codec — cosmetic, but keeps DevTools honest about what
     *  is actually stored once a generation is Brotli. */
    function _blobType(enc) {
        return enc === 'br' ? 'application/x-brotli' : 'application/gzip';
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
                    // The manifest entry's `enc` is written onto the stored
                    // record: the bytes leave their manifest behind the moment
                    // they land in IndexedDB, and Brotli cannot be recognised
                    // from the bytes (see js/codec.js). Missing -> gzip.
                    var itemEnc = PPP.codec.normalize(entry.enc);
                    // Which durable record the post-item snapshot goes into.
                    // firstInstall owns 'install'; a delta owns 'deltaInstall'
                    // and must never be mistaken for a pending first install
                    // (getResumeState / the boot resume path read 'install').
                    var stateRec = install._track
                        ? { key: install._stateKey || 'install', value: install }
                        : null;
                    if (item.type === 'core') {
                        // `storeKey` lets a DELTA park the bytes under a staging
                        // key instead of the live one (see checkForUpdates). A
                        // first install has no previous generation to protect,
                        // so it writes 'core:<key>' directly and its partial
                        // library stays openable (coreReady).
                        var key = item.storeKey || ('core:' + item.coreKey);
                        return _enqueueApply(function () {
                            install.completedCore[item.coreKey] = { hash: entry.hash, size: entry.size };
                            return store.putFile(
                                { key: key, packId: key, gz: new Blob([buf], { type: _blobType(itemEnc) }), raw: entry.raw, enc: itemEnc },
                                stateRec
                            );
                        });
                    }
                    if (item.type === 'shard') {
                        var skey = 'shard:' + entry.id;
                        return _enqueueApply(function () {
                            install.completedShards[entry.id] = { sha256: entry.sha256, size: entry.size };
                            return store.putFile(
                                { key: skey, packId: skey, gz: new Blob([buf], { type: _blobType(itemEnc) }), raw: entry.raw, enc: itemEnc },
                                stateRec
                            );
                        });
                    }
                    // Pack: parse + slice fully BEFORE the transaction opens.
                    var entries = store.parsePack(buf, _packKeyFn(entry), itemEnc);
                    return _enqueueApply(function () {
                        install.completedPacks[entry.id] = { hash: entry.hash, size: entry.size };
                        return store.applyPack(entry.id, entries, stateRec);
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

    /* ---- The atomic generation switch (A, 2026-07-28) ----------------------
     * A delta used to write each new core file straight to its live key
     * ('core:meta', 'core:extras') and advance `localManifest` only at the very
     * end. Between those two moments — the whole download of the packs and the
     * shards, minutes on a phone — the device held the NEW core beside the OLD
     * shards under an OLD manifest. Measured on a real S23 Ultra (2026-07-28):
     * a migration killed at t+7 s left exactly that state, the app opened
     * without a single error, and the same query rendered 4397 rows where the
     * clean previous generation rendered 4405. A silent wrong answer, with no
     * indication anything had happened.
     *
     * So a delta's core bytes now land under a staging key nothing reads, and
     * reach their live keys inside the SAME IndexedDB transaction that advances
     * `localManifest` (store.commitGeneration). There is no ordering left to
     * get wrong and no window to be interrupted in: a reader either sees the
     * whole previous generation or the whole next one.
     *
     * Why staging rather than "write the core files last, just before the
     * fence": the fence would still be two writes (files, then manifest) with a
     * gap between them, and the gap is the entire bug — it does not matter that
     * it got smaller. IndexedDB gives all-or-nothing across stores in one
     * transaction; the only way to use it is to have the bytes already there,
     * verified, before the transaction opens. Staging is what makes that true.
     *
     * firstInstall deliberately does NOT stage: there is no previous generation
     * to protect, and its partial library is meant to be openable (coreReady).
     */
    function _stagedCoreKey(coreKey) {
        return 'stage:core:' + coreKey;
    }

    /**
     * Carry out (and clear) the deletions a committed generation switch left
     * behind — packs and shards the new manifest no longer lists.
     *
     * They run AFTER the fence, not before it, because deleting them before
     * means a delta that then fails has already damaged the generation the user
     * is still on. Running them after needs the list to survive a crash, hence
     * `pendingDeletes`, written inside the fence transaction itself and dropped
     * only once the deletions are done. Worst case is unreferenced bytes on
     * disk until the next check — never a missing piece of a live generation.
     *
     * Deferred while isUpdatingShards(): the list can contain shard keys, and
     * deleting a shard under an in-flight addShards() is the same race the
     * delta's own shard handling defers for (Codex HIGH-1). The record stays,
     * so the next check reclaims them.
     */
    function _drainPendingDeletes() {
        if (isUpdatingShards()) return Promise.resolve();
        return store.getState('pendingDeletes').then(function (list) {
            if (!list || !list.length) return;
            // A pack and a shard are both removed by wiping every record whose
            // byPack index equals the id — applyPack(packId, []) — so one list
            // and one primitive covers both (a shard's is 'shard:<id>').
            return _runPool(list, function (packId) {
                return _enqueueApply(function () { return store.applyPack(packId, []); });
            }, 1).then(function () {
                return store.deleteState('pendingDeletes');
            });
        }).catch(function (e) {
            // Reclaiming space must never be what fails a delta: the record
            // stays and the next check tries again.
            console.warn('Deferred cleanup failed, will retry next check:', e);
        });
    }

    /* ---- What the next delta would COST, before it costs it ---------------
     * Measured on a real S23 Ultra (2026-07-28): moving an installed device to
     * the next corpus generation pulled 240 MB with no warning, no progress and
     * no question — on mobile data, that is the user's data plan spent without
     * them knowing. Rājan, 2026-07-28: "to pārvērst jautājumā — bibliotēka
     * atjaunojas, 240 MB — tagad vai Wi-Fi tīklā".
     *
     * A question needs a number BEFORE anything is fetched, so the plan phase
     * is split out of checkForUpdates(): getPendingUpdate() is a pure read
     * (manifest.json + IndexedDB state, nothing else) that answers "how many
     * bytes would the delta download". It deliberately does NOT reuse
     * checkForUpdates' body — that body writes, and the whole point here is a
     * phase that cannot. The duplication is ~30 lines of diffing against the
     * SAME helpers (_packSelected, _normLangs, CORE_KEYS), and the atomic
     * generation switch below is left untouched.
     *
     * The number is DOWNLOAD bytes only. Removals are free and are never worth
     * a question, so a generation that only drops things reports bytes: 0 and
     * the caller runs it silently — as it always did.
     */

    /**
     * Stable identity of a manifest generation, used to remember a decision
     * against the generation it was made about.
     *
     * IT COVERS EVERY ARTEFACT THE MANIFEST NAMES, not just the core (Codex
     * HIGH-1, 2026-07-28). The first version was `generated` + the core
     * hashes, and that is a consent bug rather than a cosmetic one: two
     * generations that share a core but differ in packs or shards produced the
     * SAME id, so a "download now" answered about generation A silently
     * authorised generation B — a different, possibly far larger download the
     * user was never shown. `generated` is no safety net either: it is a build
     * timestamp, and a republish can repeat it.
     *
     * So the id fingerprints the whole referenced set — core hashes, pack
     * hashes, shard sha256s, each keyed by id and sorted so manifest ORDERING
     * cannot change it. Kept as the plain fingerprint string rather than a
     * digest of it: SubtleCrypto is async and absent in insecure contexts, and
     * a non-cryptographic hash would reintroduce collisions in the exact place
     * collisions ARE the bug. ~2 KB in one IndexedDB state record costs
     * nothing.
     */
    function _generationId(mf) {
        if (!mf) return '';
        var core = mf.core || {};
        return [
            String(mf.generated || ''),
            'core:' + Object.keys(core).sort().map(function (k) {
                return k + '=' + (core[k] && core[k].hash);
            }).join(','),
            'packs:' + (mf.packs || []).map(function (p) {
                return p.id + '=' + p.hash;
            }).sort().join(','),
            'shards:' + (mf.sentenceShards || []).map(function (s) {
                return s.id + '=' + String(s.sha256 || '').slice(0, 16);
            }).sort().join(',')
        ].join('|');
    }

    /**
     * Read-only preview of the next delta. Fetches manifest.json (~100 KB) and
     * reads IndexedDB state; downloads nothing, writes nothing, deletes
     * nothing.
     *
     * Returns null when there is nothing to decide (no library installed, no
     * remote manifest, or a manifest the wipe guard refuses — that one is
     * handled by checkForUpdates itself and must not become a user question).
     * Otherwise { bytes, items, generation, resumed }:
     *   bytes     — what the delta would DOWNLOAD, from the manifest's own
     *               `size` fields, i.e. the same source computeInstallBytes
     *               uses. 0 means "nothing to fetch" (removals only).
     *   items     — changed item count, for the existing "Updated: {n}" note.
     *   generation— identity of the remote generation (see _generationId).
     *   resumed   — a delta for some generation is already part-done on this
     *               device (`deltaInstall`). The user already said yes to a
     *               download once; asking again mid-way would be the worst of
     *               both worlds, so the caller proceeds without a question.
     */
    function getPendingUpdate() {
        return fetchManifest().then(function (remote) {
            return store.getState('localManifest').then(function (local) {
                if (!local) return null;                      // not installed
                if (_manifestWipesSection(remote, local)) return null;
                return Promise.all([
                    store.getState('langs'),
                    store.getState('shards'),
                    store.getState('deltaInstall')
                ]).then(function (st) {
                    var sel = _normLangs(st[0]);
                    var includeShards = !!st[1];
                    var bytes = 0;
                    var items = 0;

                    var remoteCore = remote.core || {};
                    CORE_KEYS.forEach(function (k) {
                        var re = remoteCore[k];
                        var lo = local.core && local.core[k];
                        if (re && (!lo || lo.hash !== re.hash)) {
                            bytes += (re.size || 0);
                            items += 1;
                        }
                    });
                    // Core files dropped remotely are deletions — counted as
                    // work (so "nothing changed" stays honest) but not bytes.
                    Object.keys(local.core || {}).forEach(function (k) {
                        if (!remoteCore[k] && CORE_KEYS.indexOf(k) === -1) items += 1;
                    });

                    var localPackById = {};
                    (local.packs || []).forEach(function (p) { localPackById[p.id] = p; });
                    var remotePackIds = {};
                    (remote.packs || []).forEach(function (p) {
                        if (!_packSelected(p, sel)) return;
                        remotePackIds[p.id] = true;
                        var lo = localPackById[p.id];
                        if (!lo || lo.hash !== p.hash) {
                            bytes += (p.size || 0);
                            items += (p.count || 1);
                        }
                    });
                    (local.packs || []).forEach(function (p) {
                        if (_packSelected(p, sel) && !remotePackIds[p.id]) items += (p.count || 1);
                    });

                    // Shards mirror checkForUpdates exactly, including its
                    // opted-out branch (every locally recorded shard is a
                    // removal) and its "defer entirely while addShards() runs"
                    // rule — a round that will do no shard work must not quote
                    // shard megabytes.
                    var localShardById = {};
                    (local.sentenceShards || []).forEach(function (s) { localShardById[s.id] = s; });
                    if (isUpdatingShards()) {
                        // no shard work this round — see checkForUpdates.
                    } else if (includeShards) {
                        var remoteShardIds = {};
                        (remote.sentenceShards || []).forEach(function (s) {
                            remoteShardIds[s.id] = true;
                            var lo = localShardById[s.id];
                            if (!lo || lo.sha256 !== s.sha256) {
                                bytes += (s.size || 0);
                                items += 1;
                            }
                        });
                        (local.sentenceShards || []).forEach(function (s) {
                            if (!remoteShardIds[s.id]) items += 1;
                        });
                    } else {
                        items += (local.sentenceShards || []).length;
                    }

                    // `resumed` means "a download of THIS generation is already
                    // part-done", never merely "some delta once ran" (Codex
                    // HIGH-2). A leftover record from a generation the server
                    // has moved past is not consent for the one on offer now,
                    // so it does not suppress the question.
                    var gen = _generationId(remote);
                    var savedDelta = st[2];
                    return {
                        bytes: bytes,
                        items: items,
                        generation: gen,
                        resumed: !!(savedDelta && savedDelta.gen === gen)
                    };
                });
            });
        }).catch(function (err) {
            // Same contract as checkForUpdates: never reject. A plan that could
            // not be made is reported as such, and the caller does NOT start a
            // download on a number it does not have.
            console.warn('Update preview failed:', err);
            return { bytes: 0, items: 0, generation: null, error: err };
        });
    }

    /**
     * Delta update: remote manifest vs stored localManifest. Downloads every
     * changed core file (into a staging key), applies changed/new packs and
     * shards, then switches generation ATOMICALLY — staged core files, the
     * `localManifest` fence and the dropped-core deletions all commit in one
     * IndexedDB transaction, so an interrupted delta always leaves the whole
     * previous generation rather than a mixture of two. Resumable: work already
     * on disk (verified byte for byte) or already applied is not fetched again.
     * Never throws — returns { changedItems, coreChanged } or
     * { changedItems: 0, error }.
     *
     * `onProgress({ loadedBytes, totalBytes })` (optional, added 2026-07-28) is
     * the same shape firstInstall emits, throttled the same way. It exists
     * because a consented update has to be VISIBLE: once the user has agreed to
     * spend 240 MB, a silent bar-less download is the same complaint one step
     * later. It observes only — the work list, the fence and the commit below
     * are untouched by it, and omitting the callback restores the previous
     * behaviour byte for byte.
     */
    function checkForUpdates(onProgress) {
        // One flag per core key (derived, so a new core file cannot be
        // forgotten here). Consumers read individual keys (app.js reads
        // .meta / .extras), so extra keys are additive and break nothing.
        var coreChanged = {};
        CORE_KEYS.forEach(function (k) { coreChanged[k] = false; });
        return fetchManifest().then(function (remote) {
            return store.getState('localManifest').then(function (local) {
                if (!local) return { changedItems: 0, coreChanged: coreChanged };
                // Truncation guard (see _manifestWipesSection for the rule and
                // why the threshold is "the whole section"). Refusing means the
                // delta simply does not run: the device keeps the previous
                // healthy generation — the same property the fence gives an
                // interrupted delta — and the next check tries again, so a
                // manifest fixed on the server heals this by itself.
                //
                // Nothing is shown to the user, on purpose: the library works,
                // nothing was lost, and there is no action for them to take. A
                // warning here would only report a server-side mistake to the
                // one person who cannot fix it.
                //
                // But it must not be a SILENT refusal either, or a manifest
                // publishing error looks exactly like "no updates available"
                // forever. Hence the warn with both counts — that line is the
                // only way to tell the two apart from a user's console.
                var wipes = _manifestWipesSection(remote, local);
                if (wipes) {
                    console.warn('Offline update refused: manifest drops every ' +
                        wipes + ' — keeping the installed library');
                    return { changedItems: 0, coreChanged: coreChanged, refused: wipes };
                }
                return store.getState('langs').then(function (savedLangs) {
                return store.getState('shards').then(function (savedShards) {
                var sel = _normLangs(savedLangs);
                var includeShards = !!savedShards;

                // Reclaim whatever a previous run committed but did not finish
                // deleting, then read this delta's durable resume record. Both
                // happen before any diffing, so everything below reasons about
                // a settled store.
                return _drainPendingDeletes().then(function () {
                    return store.getState('deltaInstall');
                }).then(function (savedDelta) {

                var changedItems = 0;
                // Core files that this delta replaces. They are NOT queued as
                // work yet: the download list is decided after the resume pass
                // below, which may find some of them already staged on disk.
                var coreUpdates = [];
                CORE_KEYS.forEach(function (k) {
                    var re = remote.core[k];
                    var lo = local.core && local.core[k];
                    if (re && (!lo || lo.hash !== re.hash)) {
                        coreChanged[k] = true;
                        changedItems += 1;
                        coreUpdates.push({ coreKey: k, entry: re });
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
                var packUpdates = [];
                (remote.packs || []).forEach(function (p) {
                    if (!_packSelected(p, sel)) return;   // never pull unselected languages
                    var lo = localById[p.id];
                    if (!lo || lo.hash !== p.hash) {
                        changedItems += (p.count || 1);
                        packUpdates.push(p);
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
                //
                // DEFER entirely while isUpdatingShards() is already true (Codex
                // HIGH-1, 2026-07-28): that flag being up means addShards() is
                // mid-run — it already read the IDB shard records once to decide
                // what to skip, and will commit `shards: true` + the full shard
                // list on that decision later. If THIS delta deleted a shard out
                // from under that decision (the opted-out branch below deletes
                // every locally recorded shard whenever `includeShards` reads
                // false, which it still does until addShards()'s own commit
                // lands), addShards() would go on to commit "shards: true" over
                // a gap that was never actually filled — the library then claims
                // a shard is installed that IndexedDB does not have. Skipping
                // shard changes for one round is always safe: nothing here is
                // shard-work-in-progress, so the very next checkForUpdates()
                // call (periodic / visibility-triggered) reconciles normally
                // once the flag clears.
                var removedShards = [];
                var shardUpdates = [];
                if (isUpdatingShards()) {
                    // no-op this round — see above.
                } else if (includeShards) {
                    var remoteShardIds = {};
                    (remote.sentenceShards || []).forEach(function (s) { remoteShardIds[s.id] = true; });
                    var localShardById = {};
                    (local.sentenceShards || []).forEach(function (s) { localShardById[s.id] = s; });
                    (remote.sentenceShards || []).forEach(function (s) {
                        var lo = localShardById[s.id];
                        if (!lo || lo.sha256 !== s.sha256) {
                            changedItems += 1;
                            shardUpdates.push(s);
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

                // Another tab is already downloading a delta: stand down before
                // a single byte is fetched (Codex MEDIUM-1). Reported as `busy`,
                // never as an error — nothing failed, and the caller must NOT
                // retire the user's decision over it. The next check reconciles
                // once that tab is done, exactly like the shard deferral above.
                if (isDeltaRunningElsewhere()) {
                    return { changedItems: 0, coreChanged: coreChanged, busy: true };
                }

                // Where each replaced core file's bytes are parked while the
                // delta runs, and where they must arrive when it commits. The
                // promotion list is the SET OF REPLACED KEYS, not the set this
                // run happens to download: a resumed delta finds some of them
                // already staged (below) and must still promote them.
                var promote = coreUpdates.map(function (c) {
                    return { from: _stagedCoreKey(c.coreKey), to: 'core:' + c.coreKey };
                });

                // Durable resume state for THIS delta (B, 2026-07-28). Same
                // shape and same commit mechanism firstInstall uses — the
                // post-item snapshot is written in the SAME IndexedDB
                // transaction as the item's records — but under its own state
                // key, so a half-finished delta can never be mistaken for a
                // pending FIRST install by getResumeState()/the boot path.
                //
                // Its job is packs, and only packs. Core files and shards are
                // resumed by looking at the BYTES on disk (below), which is
                // strictly better: self-verifying, size+sha256, fail-closed,
                // and it cannot drift from reality. A pack is exploded into
                // hundreds of member records with no stored hash of its own, so
                // for packs there is nothing to verify against and a record of
                // what was applied is the only way to not download 132 MB again.
                //
                // IT IS STAMPED WITH THE GENERATION IT BELONGS TO (Codex HIGH-2,
                // 2026-07-28). Without the stamp the record is just "a delta was
                // running", and the consent gate in app.js reads its mere
                // existence as "the user already agreed to a download" — so a
                // FAILED delta for generation A silently waved through whatever
                // generation the server offered next. A record from another
                // generation is discarded outright rather than merged: its
                // completedPacks describe a work list that no longer exists,
                // and the bytes it would let us skip are re-verified from disk
                // anyway (the resume pass below), so the only thing thrown away
                // is a claim we have no reason to trust.
                var remoteGen = _generationId(remote);
                if (savedDelta && savedDelta.gen !== remoteGen) savedDelta = null;
                var install = savedDelta || { completedCore: {}, completedPacks: {}, completedShards: {} };
                if (!install.completedCore) install.completedCore = {};
                if (!install.completedPacks) install.completedPacks = {};
                if (!install.completedShards) install.completedShards = {};
                install.gen = remoteGen;
                install._track = true;
                install._stateKey = 'deltaInstall';

                // Resume pass: everything already on disk, verified byte for
                // byte, drops out of the download list. This is what turns a
                // killed migration from "236 MB again" into "only what is
                // missing". _entryAlreadyInStore is fail-closed — anything it
                // cannot PROVE is correct gets re-downloaded.
                var work = [];
                return _runPool(coreUpdates, function (c) {
                    var staged = _stagedCoreKey(c.coreKey);
                    return _entryAlreadyInStore(staged, c.entry).then(function (ok) {
                        if (ok) return;
                        work.push({
                            type: 'core', coreKey: c.coreKey, storeKey: staged,
                            name: c.entry.path, entry: c.entry
                        });
                    });
                }, CONCURRENCY).then(function () {
                    return _runPool(shardUpdates, function (s) {
                        return _shardAlreadyInStore(s).then(function (ok) {
                            if (!ok) work.push({ type: 'shard', name: s.id, entry: s });
                        });
                    }, CONCURRENCY);
                }).then(function () {
                    packUpdates.forEach(function (p) {
                        var done = install.completedPacks[p.id];
                        if (done && done.hash === p.hash) return;   // applied by an earlier attempt
                        work.push({ type: 'pack', name: p.id, entry: p });
                    });

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
                    // The cross-tab delta claim (Codex MEDIUM-1) is raised here
                    // too — at the same moment, for the same reason: from just
                    // before the first byte until the generation has switched.
                    // Unlike the shard flag it is UNCONDITIONAL: a packs-only
                    // delta is exactly the 132 MB a second tab must not fetch
                    // again.
                    _raiseDeltaClaim();
                    var _released = false;
                    function _releaseShardUpdate() {
                        if (_released) return;
                        _released = true;
                        if (touchesShards) _lowerShardUpdate();
                        _lowerDeltaClaim();
                    }

                    // Started from an already-resolved promise so that even a
                    // SYNCHRONOUS throw out of _runPool becomes a rejection this
                    // chain's handler sees. Thrown straight out of the `return`
                    // instead, it would skip the release below and leave the app
                    // reporting "updating" for the rest of the session.
                    // Progress accounting, identical in shape to firstInstall's:
                    // a per-item byte counter folded into a base on completion,
                    // reset on retry so the bar never runs ahead of reality.
                    // `totalBytes` is the DOWNLOAD size of this delta's work
                    // list — i.e. what getPendingUpdate() quoted, minus
                    // anything the resume pass found already on disk — so the
                    // number the user agreed to is the number the bar fills.
                    var totalBytes = 0;
                    work.forEach(function (w) { totalBytes += ((w.entry && w.entry.size) || 0); });
                    var baseBytes = 0;
                    var itemBytes = {};
                    var lastEmit = 0;
                    function emit(force) {
                        if (!onProgress) return;
                        var now = Date.now();
                        if (!force && now - lastEmit < 100) return;   // ~10/s
                        lastEmit = now;
                        var loaded = baseBytes;
                        for (var bk in itemBytes) loaded += itemBytes[bk];
                        onProgress({ loadedBytes: Math.min(loaded, totalBytes), totalBytes: totalBytes });
                    }
                    emit(true);

                    return Promise.resolve().then(function () {
                        return _runPool(work, function (item) {
                            itemBytes[item.name] = 0;
                            return _processItem(item, install, function (n) {
                                itemBytes[item.name] += n; emit();
                            }, function () {
                                itemBytes[item.name] = 0; emit(true);
                            }).then(function () {
                                delete itemBytes[item.name];
                                baseBytes += ((item.entry && item.entry.size) || 0);
                                emit(true);
                            });
                        }, CONCURRENCY);
                    }).then(function () {
                        // THE FENCE, and it is now a single IndexedDB
                        // transaction (store.commitGeneration) instead of a
                        // sequence of writes:
                        //   - the staged core files arrive at their live keys,
                        //   - core files dropped from the manifest disappear,
                        //   - `localManifest` advances to the new generation,
                        //   - the delta's resume record is discarded,
                        //   - and the leftovers to reclaim are recorded.
                        // Until this transaction commits, every reader still
                        // sees the PREVIOUS generation, whole: old core, old
                        // shard list, old manifest. That is the property the
                        // old code did not have — it wrote the new core files
                        // to their live keys immediately and advanced
                        // `localManifest` minutes later, so a download killed
                        // in between left new core + old shards and the app
                        // silently answered with a row count belonging to
                        // neither generation.
                        //
                        // Deletions of removed PACKS and SHARDS deliberately do
                        // NOT run before this point any more. Deleting them
                        // early damages the generation the user is still on if
                        // the delta then fails. They are recorded as
                        // `pendingDeletes` INSIDE this transaction and carried
                        // out after it — so an interruption there leaves only
                        // unreferenced bytes, and the list of what to reclaim
                        // survives (drained at the start of the next check).
                        var pending = removed.map(function (p) { return p.id; })
                            .concat(removedShards.map(function (s) { return 'shard:' + s.id; }));
                        var puts = { localManifest: _manifestForStore(remote, includeShards) };
                        if (pending.length) puts.pendingDeletes = pending;
                        // A core file is stored as a SINGLE record under its own
                        // 'core:<key>' — deleting that key is the whole removal,
                        // and `localManifest` (written in this same transaction)
                        // is what stops the device claiming it.
                        var drop = removedCore.map(function (k) { return 'core:' + k; });
                        // Plus any staged core bytes this generation does NOT
                        // consume: leftovers from an earlier delta that was
                        // abandoned (the server moved on, or reverted) would
                        // otherwise sit in IndexedDB unreferenced forever. The
                        // keys being promoted are not in this list — their
                        // staged record is consumed by the promotion itself.
                        CORE_KEYS.forEach(function (k) {
                            var stale = !coreUpdates.some(function (c) { return c.coreKey === k; });
                            if (stale) drop.push(_stagedCoreKey(k));
                        });
                        return store.commitGeneration({
                            promote: promote,
                            deleteFiles: drop,
                            puts: puts,
                            deletes: ['deltaInstall']
                        }).then(function () { return pending; });
                    }).then(function (pending) {
                        // Lowered only AFTER the generation switched: that
                        // transaction IS the moment the shards and the recorded
                        // list agree again.
                        _releaseShardUpdate();
                        if (!pending.length) return;
                        return _drainPendingDeletes();
                    }).then(function () {
                        return { changedItems: changedItems, coreChanged: coreChanged };
                    }, function (err) {
                        // Stand-in for `finally` (not in this file's ES5 baseline).
                        // A thrown delta must not leave the app stuck in "updating"
                        // — the outer .catch below would otherwise swallow the
                        // error and the flag with it.
                        _releaseShardUpdate();
                        throw err;
                    });
                });
                });   // close _drainPendingDeletes().then(getState('deltaInstall'))
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
     * Is the artefact this manifest entry describes already sitting in
     * IndexedDB under `key`, byte-for-byte? Used for sentence shards (their
     * live key) and, since the atomic generation switch, for a delta's STAGED
     * core files — which is what makes an interrupted delta resume instead of
     * re-downloading everything it had already fetched.
     * Reuses _verifyBuffer's exact size+sha256 check (the same gate a fresh
     * download has to pass) against the record already on disk, so "already
     * installed" means the SAME check as "downloaded correctly" — not two
     * divergent notions of "present" that could quietly drift apart.
     *
     * FAIL CLOSED: any reason this can't prove a full match — no record, a
     * read error, a size/hash mismatch, a codec mismatch, OR a manifest entry
     * with no sha256 at all — resolves false, i.e. (re)download. Skipping is
     * only safe on a positive match; skipping on "couldn't tell" would risk
     * leaving a corrupt/partial/wrongly-decoded shard in place forever.
     *
     * Two things this does NOT delegate to plain _verifyBuffer(), on purpose
     * (Codex HIGH-3 / MEDIUM-2, 2026-07-28):
     *   - _verifyBuffer() checks sha256 "only when the manifest carries one"
     *     (defensive for a build that has not started emitting it yet) — the
     *     right behaviour for VERIFYING A FRESH DOWNLOAD, where a size-only
     *     match is still evidence the bytes are probably right. It is the
     *     WRONG behaviour for a SKIP decision: a same-size but stale shard
     *     with no sha256 field would be waved through as "already correct"
     *     forever. So a missing sha256 here means false — a fresh download
     *     runs the (weaker) _verifyBuffer() gate as before.
     *   - The stored `enc` codec is compared to the manifest entry's,
     *     because bytes alone do not say how to decode them (see
     *     js/offline-store.js getEncoded); a record whose `enc` field was
     *     corrupted independently of its bytes would otherwise be "skipped"
     *     and later fail to decode with the wrong codec.
     *
     * Exists because addShards() used to queue every manifest shard
     * unconditionally. A device that already holds all shards in IndexedDB
     * but has `shards !== true` (e.g. a firstInstall that opted out, then an
     * unrelated event — observed: a shell/OS update — nudges it to opt back
     * in) re-downloaded the full ~119 MB set for nothing (field incident,
     * 2026-07-27).
     */
    function _entryAlreadyInStore(key, entry) {
        if (!entry.sha256) return Promise.resolve(false);
        // Fail closed when the bytes CANNOT be hashed (Codex HIGH-3,
        // 2026-07-28). _verifyBuffer degrades to a size-only check where
        // SubtleCrypto is missing (an insecure context, an old webview) — a
        // deliberate degradation on the DOWNLOAD path, where the alternative is
        // an install that cannot run at all. On the SKIP path that same
        // degradation is a silent-wrong-answer generator: a write killed
        // mid-shard can leave the previous generation's bytes under the live
        // key at exactly the length the new manifest declares, and a size-only
        // comparison then calls them correct and skips the download for good.
        // The device would search a shard from one generation while claiming
        // another — the one failure mode this whole file is built to prevent.
        // So a skip requires a real hash comparison: no digest, no skip. The
        // cost is re-downloading on such browsers, which is bytes, not
        // correctness.
        if (!(window.crypto && crypto.subtle && crypto.subtle.digest)) return Promise.resolve(false);
        // Cheap rejection first (getRecordInfo reads Blob metadata only, no
        // bytes): a record of a DIFFERENT generation under the same key almost
        // always differs in size or codec, and saying so costs one IndexedDB
        // lookup instead of reading and SHA-256-ing the blob. Without this, a
        // delta that replaces 22 shards hashed ~119 MB of the OLD generation
        // before downloading a single byte of the new one. Only a record that
        // survives the cheap checks is materialized and hashed — so the gate
        // below is exactly as strict as it was, just reached less often.
        return store.getRecordInfo(key).then(function (info) {
            if (!info) return false;
            if (info.enc !== PPP.codec.normalize(entry.enc)) return false;
            if (entry.size != null && info.size !== entry.size) return false;
            return store.getEncoded(key).then(function (rec) {
                if (!rec || !rec.buf) return false;
                if (PPP.codec.normalize(rec.enc) !== PPP.codec.normalize(entry.enc)) return false;
                return _verifyBuffer(rec.buf, entry, entry.id || key).then(
                    function () { return true; },
                    function () { return false; }
                );
            }, function () { return false; });
        }, function () { return false; });
    }

    /** The shard case of _entryAlreadyInStore(): shards live under
     *  'shard:<id>' (see _processItem). */
    function _shardAlreadyInStore(entry) {
        return _entryAlreadyInStore('shard:' + entry.id, entry);
    }

    /**
     * Add the sentence shards (offline text search, ~200 MB) to an ALREADY
     * installed library that opted out of them at install time. Mirrors
     * addLanguages(): downloads + applies only the shards that are actually
     * missing or damaged (core/EN/other languages are already present, and
     * any shard _shardAlreadyInStore() confirms is already correct on disk
     * is skipped — see that function for why), then persists `shards: true`
     * and folds the FULL manifest shard list into `localManifest` so
     * checkForUpdates' delta logic treats every shard — downloaded just now
     * or already present — as current from now on (see _manifestForStore
     * (manifest, true) — same shape, built here without re-fetching the
     * manifest twice).
     * onProgress({loadedBytes, totalBytes}) mirrors addLanguages, and only
     * accounts for bytes actually transferred (skipped shards contribute 0
     * to totalBytes — a device that already has everything sees a
     * near-instant "done", which is correct: nothing was downloaded).
     * `signal` (optional, last) cancels it exactly like firstInstall: fetches
     * aborted, no further item started, `shards: true` NOT committed.
     *
     * MUTUAL EXCLUSION WITH checkForUpdates() (Codex HIGH-1, 2026-07-28): this
     * function holds the SAME isUpdatingShards() flag checkForUpdates() uses
     * for its own shard-touching deltas, for its ENTIRE run — from before the
     * very first IndexedDB presence-check through the final commit. Without
     * this, checkForUpdates() could run concurrently (its `shards` state read
     * is still false until THIS function's own commit lands), see
     * `includeShards === false`, and delete every shard record this function
     * had just decided — a heartbeat earlier — were already correctly
     * installed; this function would then go on to commit `shards: true` +
     * the full shard list over that gap, leaving the library CLAIMING an
     * index that IndexedDB does not actually hold. If another shard-touching
     * operation already holds the flag when this one is called, it refuses
     * outright (_libraryUpdatingError) rather than race it from the other
     * side — the caller (app.js) already has retry/error-screen handling for
     * a rejected addShards().
     */
    function addShards(onProgress, signal) {
        if (_isAborted(signal)) return Promise.reject(_abortError());
        if (isUpdatingShards()) return Promise.reject(_libraryUpdatingError());
        _raiseShardUpdate();
        var released = false;
        function release() { if (!released) { released = true; _lowerShardUpdate(); } }

        return fetchManifest(signal).then(function (manifest) {
            if (_isAborted(signal)) throw _abortError();
            var shardEntries = (manifest.sentenceShards || []).filter(function (s) { return !!s; });

            // Classify each shard as "already correct on disk" vs "needs a
            // fetch" at bounded concurrency (CONCURRENCY, same as every
            // download pool in this file) rather than firing every shard's
            // IndexedDB read + full ArrayBuffer materialization + SHA-256
            // digest at once via Promise.all (Codex MEDIUM-1, 2026-07-28): a
            // 22-shard, ~119 MB generation read all-at-once would put the
            // WHOLE set in memory simultaneously, on a device whose tightest
            // budget is search's own ~173 MB transient — and it would do so
            // BEFORE any download work even starts. _runPool already handles
            // the abort-checking and first-error propagation this needs.
            var toFetch = [];
            return _runPool(shardEntries, function (s) {
                return _shardAlreadyInStore(s).then(function (ok) { if (!ok) toFetch.push(s); });
            }, CONCURRENCY, signal).then(function () {
                if (_isAborted(signal)) throw _abortError();
                var work = [];
                var totalBytes = 0;
                toFetch.forEach(function (s) {
                    work.push({ type: 'shard', name: s.id, entry: s });
                    totalBytes += (s.size || 0);
                });

                function _commitShardsPresent() {
                    return store.getState('localManifest').then(function (lm) {
                        var updated = {};
                        if (lm) Object.keys(lm).forEach(function (k) { updated[k] = lm[k]; });
                        updated.sentenceShards = manifest.sentenceShards || [];
                        return store.commitState({ shards: true, localManifest: updated }, []);
                    }).then(function () {
                        return { added: true };
                    });
                }

                if (work.length === 0) {
                    return _commitShardsPresent();
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
                    return _commitShardsPresent();
                });
            });
        }).then(function (result) {
            release();
            return result;
        }, function (err) {
            release();
            throw err;
        });
    }

    return {
        fetchManifest: fetchManifest,
        firstInstall: firstInstall,
        checkForUpdates: checkForUpdates,
        getPendingUpdate: getPendingUpdate,
        computeInstallBytes: computeInstallBytes,
        getInstalledLangs: getInstalledLangs,
        addLanguages: addLanguages,
        addShards: addShards,
        isUpdatingShards: isUpdatingShards,
        isDeltaRunningElsewhere: isDeltaRunningElsewhere,
        getResumeState: getResumeState,
        isCoreReady: isCoreReady
    };
})();
