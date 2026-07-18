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

    function fetchManifest() {
        return fetch('data/manifest.json', { cache: 'no-store' }).then(function (r) {
            if (!r.ok) throw new Error('manifest HTTP ' + r.status);
            return r.json();
        });
    }

    function _itemUrl(item) {
        return item.path + '?v=' + item.hash;
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
     * full library (manifest bytes × 1.4 headroom). Advisory API — when
     * estimate() is unavailable the install just proceeds.
     */
    function _storagePreflight(manifest) {
        if (!(navigator.storage && navigator.storage.estimate)) return Promise.resolve();
        return navigator.storage.estimate().then(function (est) {
            if (!est || est.quota == null || est.usage == null) return;
            var free = est.quota - est.usage;
            if (free < manifest.totals.bytes * 1.4) {
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
                    if (item.type === 'core') {
                        var key = 'core:' + item.coreKey;
                        install.completedCore[item.coreKey] = { hash: entry.hash, size: entry.size };
                        return _enqueueApply(function () {
                            return store.putFile(
                                { key: key, packId: key, gz: new Blob([buf], { type: 'application/gzip' }), raw: entry.raw },
                                install._track ? { key: 'install', value: install } : null
                            );
                        });
                    }
                    // Pack: parse + slice fully BEFORE the transaction opens.
                    var entries = store.parsePack(buf, _packKeyFn(entry));
                    install.completedPacks[entry.id] = { hash: entry.hash, size: entry.size };
                    return _enqueueApply(function () {
                        return store.applyPack(entry.id, entries,
                            install._track ? { key: 'install', value: install } : null);
                    });
                })
                .catch(function (err) {
                    // One retry per item on mismatch/network error; roll back
                    // this item's progress bytes so the bar stays truthful.
                    if (item.type === 'core') delete install.completedCore[item.coreKey];
                    else delete install.completedPacks[entry.id];
                    resetBytes();
                    if (attempt < 2) return tryOnce();
                    throw new Error('Download failed: ' + item.name + ' (' + err.message + ')');
                });
        }
        return tryOnce();
    }

    /**
     * Build the outstanding work list for a manifest given resume state.
     */
    function _buildWorkList(manifest, install) {
        var work = [];
        var doneBytes = 0;
        ['meta', 'extras', 'sentences'].forEach(function (k) {
            var entry = manifest.core[k];
            if (!entry) return;
            var done = install.completedCore[k];
            if (done && done.hash === entry.hash) doneBytes += entry.size;
            else work.push({ type: 'core', coreKey: k, name: entry.path, entry: entry });
        });
        (manifest.packs || []).forEach(function (p) {
            var done = install.completedPacks[p.id];
            if (done && done.hash === p.hash) doneBytes += p.size;
            else work.push({ type: 'pack', name: p.id, entry: p });
        });
        return { work: work, doneBytes: doneBytes };
    }

    /**
     * First full install. Resumable: already-completed items (recorded in the
     * durable `install` state, hash-compared against the current manifest)
     * are skipped and pre-counted into the progress bar.
     * onProgress({ loadedBytes, totalBytes }) — throttled to ~10/s.
     */
    function firstInstall(onProgress) {
        return fetchManifest().then(function (manifest) {
            return _storagePreflight(manifest).then(function () {
                return store.getState('install');
            }).then(function (saved) {
                var install = saved || { completedCore: {}, completedPacks: {} };
                install._track = true;   // commit install snapshots with each item
                var plan = _buildWorkList(manifest, install);
                var totalBytes = manifest.totals.bytes;
                var baseBytes = plan.doneBytes;
                var itemBytes = {};      // per-item received bytes (reset on retry)
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
                    });
                }, CONCURRENCY).then(function () {
                    emit(true);
                    return store.setState('localManifest', manifest);
                }).then(function () {
                    return store.deleteState('install');
                }).then(function () {
                    return manifest;
                });
            });
        });
    }

    /**
     * Delta update: remote manifest vs stored localManifest. Downloads and
     * applies every changed core file and changed/new pack, deletes packs that
     * were removed from the manifest, and ONLY THEN advances localManifest
     * (fence: a partial update never claims to be current). Never throws —
     * returns { changedItems, coreChanged } or { changedItems: 0, error }.
     */
    function checkForUpdates() {
        var coreChanged = { meta: false, extras: false, sentences: false };
        return fetchManifest().then(function (remote) {
            return store.getState('localManifest').then(function (local) {
                if (!local) return { changedItems: 0, coreChanged: coreChanged };

                var changedItems = 0;
                var work = [];
                ['meta', 'extras', 'sentences'].forEach(function (k) {
                    var re = remote.core[k];
                    var lo = local.core && local.core[k];
                    if (re && (!lo || lo.hash !== re.hash)) {
                        coreChanged[k] = true;
                        changedItems += 1;
                        work.push({ type: 'core', coreKey: k, name: re.path, entry: re });
                    }
                });
                var remoteIds = {};
                (remote.packs || []).forEach(function (p) { remoteIds[p.id] = true; });
                var localById = {};
                (local.packs || []).forEach(function (p) { localById[p.id] = p; });
                (remote.packs || []).forEach(function (p) {
                    var lo = localById[p.id];
                    if (!lo || lo.hash !== p.hash) {
                        changedItems += (p.count || 1);
                        work.push({ type: 'pack', name: p.id, entry: p });
                    }
                });
                // Packs removed from the manifest → delete their members.
                var removed = (local.packs || []).filter(function (p) { return !remoteIds[p.id]; });
                removed.forEach(function (p) { changedItems += (p.count || 1); });

                if (changedItems === 0) return { changedItems: 0, coreChanged: coreChanged };

                // Updates share the install-state shape but do NOT track
                // durable resume state (no _track) — a failed delta simply
                // re-runs next time against the unchanged localManifest.
                var install = { completedCore: {}, completedPacks: {} };
                return _runPool(work, function (item) {
                    return _processItem(item, install, null, function () {});
                }, CONCURRENCY).then(function () {
                    return _runPool(removed, function (p) {
                        return _enqueueApply(function () { return store.applyPack(p.id, []); });
                    }, 1);
                }).then(function () {
                    // Fence: everything applied and verified — only now
                    // advance the local manifest.
                    return store.setState('localManifest', remote);
                }).then(function () {
                    return { changedItems: changedItems, coreChanged: coreChanged };
                });
            });
        }).catch(function (err) {
            console.warn('Offline update check failed:', err);
            return { changedItems: 0, coreChanged: coreChanged, error: err };
        });
    }

    return {
        fetchManifest: fetchManifest,
        firstInstall: firstInstall,
        checkForUpdates: checkForUpdates
    };
})();
