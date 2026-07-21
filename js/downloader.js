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
        ['meta', 'extras'].forEach(function (k) {
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
     * full library (manifest bytes × 1.4 headroom). Advisory API — when
     * estimate() is unavailable the install just proceeds.
     */
    function _storagePreflight(manifest, langs, includeShards) {
        if (!(navigator.storage && navigator.storage.estimate)) return Promise.resolve();
        var needBytes = computeInstallBytes(manifest, langs, includeShards);
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
                    if (item.type === 'shard') {
                        var skey = 'shard:' + entry.id;
                        install.completedShards[entry.id] = { sha256: entry.sha256, size: entry.size };
                        return _enqueueApply(function () {
                            return store.putFile(
                                { key: skey, packId: skey, gz: new Blob([buf], { type: 'application/gzip' }), raw: entry.raw },
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
                    else if (item.type === 'shard') delete install.completedShards[entry.id];
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
        ['meta', 'extras'].forEach(function (k) {
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
        return fetchManifest().then(function (manifest) {
            return _storagePreflight(manifest, sel, wantShards).then(function () {
                return store.getState('install');
            }).then(function (saved) {
                var install = saved || { completedCore: {}, completedPacks: {}, completedShards: {} };
                if (!install.completedShards) install.completedShards = {};
                install._track = true;   // commit install snapshots with each item
                var plan = _buildWorkList(manifest, install, sel, wantShards);
                var totalBytes = computeInstallBytes(manifest, sel, wantShards);
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
                    // The stored localManifest must reflect what was actually
                    // installed: when shards are opted out, strip them so the
                    // delta check never treats the (never-downloaded) shards as
                    // present. Runtime shard search reads the LIVE manifest
                    // (db.js), not this stored copy, so this is safe.
                    return store.setState('localManifest', _manifestForStore(manifest, wantShards));
                }).then(function () {
                    // Persist the installed opt-in language selection so delta
                    // updates and "add a language later" know what to maintain.
                    return store.setState('langs', sel);
                }).then(function () {
                    // Persist the shard opt-in choice so delta updates know
                    // whether to keep the sentence shards fresh.
                    return store.setState('shards', wantShards);
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
        var coreChanged = { meta: false, extras: false };
        return fetchManifest().then(function (remote) {
            return store.getState('localManifest').then(function (local) {
                if (!local) return { changedItems: 0, coreChanged: coreChanged };
                return store.getState('langs').then(function (savedLangs) {
                return store.getState('shards').then(function (savedShards) {
                var sel = _normLangs(savedLangs);
                var includeShards = !!savedShards;

                var changedItems = 0;
                var work = [];
                ['meta', 'extras'].forEach(function (k) {
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

    return {
        fetchManifest: fetchManifest,
        firstInstall: firstInstall,
        checkForUpdates: checkForUpdates,
        computeInstallBytes: computeInstallBytes,
        getInstalledLangs: getInstalledLangs,
        addLanguages: addLanguages
    };
})();
