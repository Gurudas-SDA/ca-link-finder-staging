/* ===========================================================================
   PPP Link Finder — Database abstraction (sql.js / SQLite in browser)
   Uses Web Worker for non-blocking DB parsing when available.
   Falls back to main-thread sql.js if Workers are unsupported.
   =========================================================================== */
window.PPP = window.PPP || {};

PPP.db = (function () {
    'use strict';

    // ===== WEB WORKER MODE =====
    var worker = null;
    var pendingCallbacks = {};  // { id: { resolve, reject } }
    var progressCallbacks = {}; // { dbName: fn(progress) }
    var msgId = 0;
    var useWorker = false;

    // ===== MAIN-THREAD FALLBACK =====
    var SQL = null;
    var databases = {};  // { dbName: SQL.Database } — only used in fallback mode

    var WASM_CDN = 'js/vendor/sql-wasm.wasm';

    // DB name constants
    var META = 'meta';

    // Loading state tracking
    var loadingDBs = {};  // { dbName: Promise } — deduplicates concurrent load requests
    var loadedDBs = {};   // { dbName: true } — tracks which DBs have been loaded

    // ===== DB VERSIONS (cache-busting) =====
    var dbVersionsPromise = null;
    function getDbVersions() {
        if (!dbVersionsPromise) {
            dbVersionsPromise = fetch('data/db-versions.json', { cache: 'no-store' })
                .then(function (r) { return r.ok ? r.json() : {}; })
                .catch(function () { return {}; });
        }
        return dbVersionsPromise;
    }

    /**
     * Send a message to Worker and return a Promise for the response.
     * Optional `transfer` is a transferable list (e.g. an ArrayBuffer that
     * should move, not copy, to the Worker).
     */
    function workerCall(cmd, data, transfer) {
        return new Promise(function (resolve, reject) {
            var id = ++msgId;
            pendingCallbacks[id] = { resolve: resolve, reject: reject };
            var msg = Object.assign({ id: id, cmd: cmd }, data || {});
            if (transfer && transfer.length) worker.postMessage(msg, transfer);
            else worker.postMessage(msg);
        });
    }

    /**
     * Handle Worker messages.
     */
    function onWorkerMessage(e) {
        var msg = e.data;

        // Progress broadcasts (no id)
        if (msg.cmd === 'progress' && msg.dbName) {
            var cb = progressCallbacks[msg.dbName];
            if (cb) cb(msg.progress);
            return;
        }

        // Response to a specific call
        var pending = pendingCallbacks[msg.id];
        if (!pending) return;
        delete pendingCallbacks[msg.id];

        if (msg.error) {
            pending.reject(new Error(msg.error));
        } else {
            pending.resolve(msg.result);
        }
    }

    /**
     * Try to initialize Worker. Returns true if successful.
     */
    function tryInitWorker() {
        try {
            worker = new Worker('js/db-worker.js?v=cache5');
            worker.onmessage = onWorkerMessage;
            worker.onerror = function (err) {
                console.warn('DB Worker error, falling back to main thread:', err);
                useWorker = false;
                worker = null;
                // Reject all pending callbacks so promises don't hang
                var ids = Object.keys(pendingCallbacks);
                ids.forEach(function (id) {
                    var cb = pendingCallbacks[id];
                    delete pendingCallbacks[id];
                    cb.reject(new Error('Worker crashed'));
                });
            };
            useWorker = true;
            return true;
        } catch (e) {
            console.warn('Web Workers not supported, using main thread:', e);
            return false;
        }
    }

    // ===== MAIN-THREAD FALLBACK FUNCTIONS =====

    function initSqlJsFallback() {
        if (SQL) return Promise.resolve(SQL);
        return window.initSqlJs({
            locateFile: function () { return WASM_CDN; }
        }).then(function (sqlModule) {
            SQL = sqlModule;
            return SQL;
        });
    }

    function fetchDBFallback(url, dbName, progressCallback) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.responseType = 'arraybuffer';

            if (progressCallback) {
                xhr.onprogress = function (e) {
                    if (e.lengthComputable) progressCallback(e.loaded / e.total);
                };
            }

            xhr.onload = function () {
                if (xhr.status === 200 || xhr.status === 0) {
                    setTimeout(function () {
                        try {
                            var arr = new Uint8Array(xhr.response);
                            databases[dbName] = new SQL.Database(arr);
                            resolve();
                        } catch (err) {
                            reject(err);
                        }
                    }, 50);
                } else {
                    reject(new Error('HTTP ' + xhr.status + ' loading ' + url));
                }
            };

            xhr.onerror = function () {
                reject(new Error('Network error loading ' + url));
            };

            xhr.send();
        });
    }

    function runQueryFallback(dbName, sql, params) {
        var db = databases[dbName];
        if (!db) throw new Error('Database "' + dbName + '" not loaded');
        var results = [];
        var stmt = db.prepare(sql);
        try {
            if (params) stmt.bind(params);
            while (stmt.step()) {
                results.push(stmt.getAsObject());
            }
        } finally {
            stmt.free();
        }
        return results;
    }

    // ===== PUBLIC API =====

    /**
     * Initialize sql.js engine (Worker or main thread).
     */
    function initSqlJs() {
        if (useWorker) {
            return workerCall('init');
        }

        // Try Worker first
        if (tryInitWorker()) {
            return workerCall('init').catch(function (err) {
                console.warn('Worker init failed, falling back:', err);
                useWorker = false;
                worker = null;
                return initSqlJsFallback();
            });
        }

        return initSqlJsFallback();
    }

    /**
     * Generic DB loader with deduplication.
     */
    function loadDB(dbName, url, progressCallback) {
        // Already loaded?
        if (loadedDBs[dbName]) return Promise.resolve();
        if (!useWorker && databases[dbName]) return Promise.resolve();

        // Deduplicate concurrent requests
        if (loadingDBs[dbName]) return loadingDBs[dbName];

        if (progressCallback) {
            progressCallbacks[dbName] = progressCallback;
        }

        // Worker needs absolute URL (its base is js/, not page root)
        var resolvedUrl = useWorker ? new URL(url, location.href).href : url;

        var promise;
        if (useWorker) {
            promise = workerCall('loadDB', { dbName: dbName, url: resolvedUrl }).then(function () {
                loadedDBs[dbName] = true;
                delete loadingDBs[dbName];
                delete progressCallbacks[dbName];
            }).catch(function (err) {
                delete loadingDBs[dbName];
                delete progressCallbacks[dbName];
                throw err;
            });
        } else {
            promise = initSqlJsFallback().then(function () {
                return fetchDBFallback(url, dbName, progressCallback);
            }).then(function () {
                loadedDBs[dbName] = true;
                delete loadingDBs[dbName];
            }).catch(function (err) {
                delete loadingDBs[dbName];
                throw err;
            });
        }

        loadingDBs[dbName] = promise;
        return promise;
    }

    /**
     * True when this browsing context can decompress gzip DB downloads —
     * either the Worker (which has its own DecompressionStream check and a
     * main-thread fallback via _openGzInto) or the main thread itself.
     */
    function _gzSupported() {
        return useWorker || (typeof DecompressionStream !== 'undefined');
    }

    /**
     * Fetch a gzip-compressed DB over the network (XHR, progress-reporting)
     * and open it via _openGzInto. Same dedup bookkeeping as loadDB() —
     * concurrent calls for the same dbName share one in-flight download.
     */
    function fetchGzDB(dbName, gzUrl, progressCallback) {
        if (loadedDBs[dbName]) return Promise.resolve();
        if (!useWorker && databases[dbName]) return Promise.resolve();
        if (loadingDBs[dbName]) return loadingDBs[dbName];

        var promise = new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', gzUrl, true);
            xhr.responseType = 'arraybuffer';

            if (progressCallback) {
                xhr.onprogress = function (e) {
                    if (e.lengthComputable) progressCallback(e.loaded / e.total);
                };
            }

            xhr.onload = function () {
                if (xhr.status === 200 || xhr.status === 0) {
                    resolve(xhr.response);
                } else {
                    reject(new Error('HTTP ' + xhr.status + ' loading ' + gzUrl));
                }
            };

            xhr.onerror = function () {
                reject(new Error('Network error loading ' + gzUrl));
            };

            xhr.send();
        }).then(function (arrayBuffer) {
            return _openGzInto(dbName, arrayBuffer);
        }).then(function () {
            loadedDBs[dbName] = true;
            delete loadingDBs[dbName];
        }).catch(function (err) {
            delete loadingDBs[dbName];
            throw err;
        });

        loadingDBs[dbName] = promise;
        return promise;
    }

    // ===== OFFLINE (IndexedDB) GZ PATH =====

    function _mainThreadDecompress(gzArrayBuffer) {
        return new Response(
            new Blob([gzArrayBuffer]).stream().pipeThrough(new DecompressionStream('gzip'))
        ).arrayBuffer();
    }

    /**
     * Raw open of a gzipped DB buffer into `dbName` (no dedup bookkeeping).
     * Happy path: transfer a COPY of the gz buffer to the Worker (the
     * original stays usable for the fallback chain). Fallbacks:
     *   worker openGz fails → decompress on main thread → worker openBuffer
     *   worker unusable      → main-thread SQL.Database (existing pattern)
     */
    function _openGzInto(dbName, gzArrayBuffer) {
        if (useWorker) {
            var copy = gzArrayBuffer.slice(0);
            return workerCall('openGz', { dbName: dbName, buffer: copy }, [copy])
                .catch(function (err) {
                    console.warn('Worker openGz failed, decompressing on main thread:', err);
                    return _mainThreadDecompress(gzArrayBuffer).then(function (buf) {
                        if (useWorker && worker) {
                            return workerCall('openBuffer', { dbName: dbName, buffer: buf }, [buf]);
                        }
                        return initSqlJsFallback().then(function () {
                            databases[dbName] = new SQL.Database(new Uint8Array(buf));
                        });
                    });
                });
        }
        return initSqlJsFallback().then(function () {
            return _mainThreadDecompress(gzArrayBuffer);
        }).then(function (buf) {
            databases[dbName] = new SQL.Database(new Uint8Array(buf));
        });
    }

    /**
     * Open a database from a gzipped ArrayBuffer (offline store path), with
     * the same dedup bookkeeping as loadDB().
     */
    function openDBFromGz(dbName, gzArrayBuffer) {
        if (loadedDBs[dbName]) return Promise.resolve();
        if (!useWorker && databases[dbName]) return Promise.resolve();
        if (loadingDBs[dbName]) return loadingDBs[dbName];

        var promise = _openGzInto(dbName, gzArrayBuffer).then(function () {
            loadedDBs[dbName] = true;
            delete loadingDBs[dbName];
        }).catch(function (err) {
            delete loadingDBs[dbName];
            throw err;
        });
        loadingDBs[dbName] = promise;
        return promise;
    }

    /**
     * True when the offline store module is available and usable.
     */
    function _offlineStoreUsable() {
        return !!(window.PPP && PPP.offlineStore && PPP.offlineStore.supported());
    }

    /**
     * Try the offline store first for a core DB; null → caller uses network.
     */
    function _tryOfflineCore(coreKey, dbName) {
        if (!_offlineStoreUsable()) return Promise.resolve(false);
        return PPP.offlineStore.getGz(coreKey).then(function (gz) {
            if (!gz) return false;
            return openDBFromGz(dbName, gz).then(function () { return true; });
        }).catch(function (err) {
            console.warn('Offline ' + coreKey + ' open failed, using network:', err);
            return false;
        });
    }

    /**
     * Force-reopen the meta DB from the offline store (delta updates: the
     * IDB copy changed while this session has the old bytes open). Bypasses
     * the loadedDBs dedup on purpose. Resolves true when reloaded.
     */
    function reloadMetaFromStore() {
        if (!_offlineStoreUsable()) return Promise.resolve(false);
        return PPP.offlineStore.getGz('core:meta').then(function (gz) {
            if (!gz) return false;
            return _openGzInto(META, gz).then(function () { return true; });
        });
    }

    /**
     * Fetch and open the metadata database.
     * NEW first path: the offline store (IndexedDB, no network). The legacy
     * network path stays for unsupported browsers / not-yet-installed state.
     */
    function loadMetaDB(progressCallback) {
        if (loadedDBs[META]) return Promise.resolve();
        return _tryOfflineCore('core:meta', META).then(function (opened) {
            if (opened) return;
            return getDbVersions().then(function (versions) {
                var v = versions.meta ? '?v=' + versions.meta : '';
                if (_gzSupported()) {
                    return fetchGzDB(META, 'data/ppp_meta.db.gz' + v, progressCallback)
                        .catch(function (err) {
                            console.warn('Gz meta fetch failed, falling back to uncompressed:', err);
                            return loadDB(META, 'data/ppp_meta.db' + v, progressCallback);
                        });
                }
                return loadDB(META, 'data/ppp_meta.db' + v, progressCallback);
            });
        });
    }

    /**
     * Lazy-load an HTML transcript database for a given language.
     */
    function loadHtmlDB(lang, progressCallback) {
        lang = lang || 'en';
        var dbName = 'html_' + lang;
        return getDbVersions().then(function (versions) {
            var v = versions[lang] ? '?v=' + versions[lang] : '';
            return loadDB(dbName, 'data/ppp_transcripts_html_' + lang + '.db' + v, progressCallback);
        });
    }

    /**
     * Lazy-load the transcript-sentence database (Advanced / "In Transcripts" search).
     * Self-contained DB (sentences + lectures tables). Cache-bust via versions.sentences,
     * but tolerate a missing key (db-versions.json may not yet list "sentences").
     */
    function loadSentencesDB(progressCallback) {
        if (loadedDBs['sentences_en']) return Promise.resolve();
        return _tryOfflineCore('core:sentences', 'sentences_en').then(function (opened) {
            if (opened) return;
            return getDbVersions().then(function (versions) {
                var v = versions.sentences ? '?v=' + versions.sentences : '';
                if (_gzSupported()) {
                    return fetchGzDB('sentences_en', 'data/ppp_sentences_en.db.gz' + v, progressCallback)
                        .catch(function (err) {
                            console.warn('Gz sentences fetch failed, falling back to uncompressed:', err);
                            return loadDB('sentences_en', 'data/ppp_sentences_en.db' + v, progressCallback);
                        });
                }
                return loadDB('sentences_en', 'data/ppp_sentences_en.db' + v, progressCallback);
            });
        });
    }

    // ===== CHUNKED SENTENCE SEARCH (Phase B — 21 shards) =====
    //
    // Instead of loading one big sentences DB whole-file, iterate the
    // manifest's `sentenceShards`. For EACH shard: fetch its gz → open in
    // sql.js → run the query → collect rows → FREE the DB before the next
    // shard. Only ONE shard DB is ever resident (peak RAM ≈ one ~30 MB shard).
    // Rows from all shards are concatenated, re-sorted with the SAME ORDER BY
    // the SQL uses, then capped to $limit. Per-shard COUNTs sum to the total
    // (shard nr-ranges are disjoint, so DISTINCT-lecture counts also sum).

    var _shardsPromise = null;
    function _getSentenceShards() {
        if (!_shardsPromise) {
            _shardsPromise = fetch('data/manifest.json', { cache: 'no-store' })
                .then(function (r) { return r.ok ? r.json() : {}; })
                .then(function (m) { return (m && m.sentenceShards) || []; })
                .catch(function () { return []; });
        }
        return _shardsPromise;
    }

    // Fetch a gz shard over the network (XHR arraybuffer, same-origin baseline).
    function _fetchGzBytes(url) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.responseType = 'arraybuffer';
            xhr.onload = function () {
                if (xhr.status === 200 || xhr.status === 0) resolve(xhr.response);
                else reject(new Error('HTTP ' + xhr.status + ' loading ' + url));
            };
            xhr.onerror = function () { reject(new Error('Network error loading ' + url)); };
            xhr.send();
        });
    }

    // Cheap O(1) integrity gate for a shard gz buffer: byte length must match
    // the manifest's declared size. Catches truncated/partial/wrong-length
    // blobs (network or IDB) without re-hashing (perf: no per-query sha256 —
    // IDB copies were already sha256-validated at install time by
    // downloader._verifyBuffer; re-hashing ~200MB per search would badly
    // regress the already-slow (~9-11s) sentence search).
    function _shardSizeOk(gz, shard) {
        if (shard.size == null) return true;               // manifest lacks size → skip
        var len = (gz && gz.byteLength != null) ? gz.byteLength
                : (gz && gz.size != null) ? gz.size : null;
        return len == null || len === shard.size;          // unknown length → don't block
    }

    // Delete a single corrupt shard from the offline IDB store. Shards are
    // stored with packId === 'shard:'+id (see downloader.js _processItem),
    // so an empty applyPack() removes just that shard's record(s) — the SAME
    // mechanism the downloader itself uses to delete removed shards during
    // delta sync (downloader.js, applyPack('shard:' + s.id, [])). Falls back
    // to a silent no-op if the store API is unavailable — the caller still
    // falls through to a network refetch.
    function _deleteIdbShard(id) {
        try {
            if (PPP.offlineStore && PPP.offlineStore.applyPack) {
                return Promise.resolve(PPP.offlineStore.applyPack('shard:' + id, []));
            }
        } catch (e) { /* fall through */ }
        return Promise.resolve();
    }

    // Network fetch of a shard, cache-busted by its sha256 prefix (so a
    // stale/updated shard at the same path can't be served from the SW cache),
    // then size-validated. Fails closed on a size mismatch — never opens a
    // truncated/corrupt buffer in sql.js.
    function _fetchValidatedShard(shard) {
        var netUrl = shard.path + (shard.sha256 ? ('?v=' + String(shard.sha256).slice(0, 16)) : '');
        return _fetchGzBytes(netUrl).then(function (gz) {
            if (!_shardSizeOk(gz, shard)) {
                throw new Error('Corrupt/partial shard ' + shard.id + ' (size '
                    + (gz && gz.byteLength) + ' != ' + shard.size + ')');
            }
            return gz;
        });
    }

    // Get a shard's gz bytes: reuse an offline IDB copy when present (with a
    // cheap size recheck), else the required same-origin network baseline
    // (cache-busted + size-validated). A corrupt IDB copy is dropped and
    // refetched from network; a corrupt network response fails closed.
    // Returns Promise<ArrayBuffer>.
    function _getShardGz(shard) {
        if (_offlineStoreUsable()) {
            return PPP.offlineStore.getGz('shard:' + shard.id).then(function (gz) {
                if (gz && _shardSizeOk(gz, shard)) return gz;   // hot path: trust IDB (sha256-checked at install) + cheap size recheck
                if (gz) {
                    // Wrong size → corrupt IDB copy. Drop it, refetch from network.
                    console.warn('Corrupt IDB shard ' + shard.id + ' — deleting + refetching');
                    return _deleteIdbShard(shard.id).then(function () { return _fetchValidatedShard(shard); });
                }
                return _fetchValidatedShard(shard);             // IDB miss → network
            }).catch(function () { return _fetchValidatedShard(shard); });
        }
        return _fetchValidatedShard(shard);
    }

    // Main-thread: open a decompressed shard buffer, run query (+count), free.
    function _mainThreadShardQuery(decompressed, sql, countSql, params) {
        var db = new SQL.Database(new Uint8Array(decompressed));
        try {
            var out = { rows: [] };
            var stmt = db.prepare(sql);
            try {
                if (params) stmt.bind(params);
                while (stmt.step()) out.rows.push(stmt.getAsObject());
            } finally { stmt.free(); }
            out.count = null;
            if (countSql) {
                var cstmt = db.prepare(countSql);
                try {
                    if (params) cstmt.bind(params);
                    var crows = [];
                    while (cstmt.step()) crows.push(cstmt.getAsObject());
                    out.count = crows;
                } finally { cstmt.free(); }
            }
            return out;
        } finally {
            db.close();  // free immediately — one-shard-resident invariant
        }
    }

    // Open+query+dispose one shard's gz buffer. Worker path is the baseline;
    // fallbacks mirror _openGzInto (worker openGz fail → main-thread decompress
    // → worker openBuffer; worker unusable → pure main-thread sql.js).
    function _shardQueryClose(gzArrayBuffer, sql, countSql, params) {
        if (useWorker) {
            var copy = gzArrayBuffer.slice(0);
            return workerCall('openQueryClose',
                { buffer: copy, sql: sql, countSql: countSql, params: params }, [copy])
                .catch(function (err) {
                    console.warn('Worker openQueryClose failed, decompressing on main thread:', err);
                    return _mainThreadDecompress(gzArrayBuffer).then(function (buf) {
                        if (useWorker && worker) {
                            var b2 = buf;
                            return workerCall('queryCloseBuffer',
                                { buffer: b2, sql: sql, countSql: countSql, params: params }, [b2]);
                        }
                        return initSqlJsFallback().then(function () {
                            return _mainThreadShardQuery(buf, sql, countSql, params);
                        });
                    });
                });
        }
        return initSqlJsFallback().then(function () {
            return _mainThreadDecompress(gzArrayBuffer);
        }).then(function (buf) {
            return _mainThreadShardQuery(buf, sql, countSql, params);
        });
    }

    // Merge comparator — mirrors the SQL ORDER BY in buildTranscriptSQL:
    //   CASE WHEN date unknown/null THEN 1 ELSE 0 END,  (knowns first)
    //   date DESC,  s.nr ASC,  s.seq ASC
    function _sentenceRowCmp(a, b) {
        var au = (!a.date || a.date === 'unknown') ? 1 : 0;
        var bu = (!b.date || b.date === 'unknown') ? 1 : 0;
        if (au !== bu) return au - bu;
        if (au === 0) {  // both dates known → DESC
            if (a.date < b.date) return 1;
            if (a.date > b.date) return -1;
        }
        if (a.nr !== b.nr) return (a.nr || 0) - (b.nr || 0);
        return (a.seq || 0) - (b.seq || 0);
    }

    /**
     * Chunked full-text sentence search across all manifest shards.
     * Runs the given `sql` / `countSql` (built by search.buildTranscriptSQL)
     * once per shard, one shard resident at a time, then merges + re-caps.
     * `onProgress(done, total)` fires after each shard completes.
     * Resolves { rows, count, lectures } (rows already capped to params.$limit).
     */
    function searchSentencesChunked(sql, countSql, params, onProgress) {
        return _getSentenceShards().then(function (shards) {
            var total = shards.length;
            if (!total) throw new Error('No sentence shards in manifest');
            var allRows = [];
            var totalCount = 0;
            var totalLectures = 0;
            var idx = 0;

            function next() {
                if (idx >= total) return Promise.resolve();
                var shard = shards[idx];
                return _getShardGz(shard).then(function (gz) {
                    return _shardQueryClose(gz, sql, countSql, params);
                }).then(function (res) {
                    if (res && res.rows && res.rows.length) {
                        allRows = allRows.concat(res.rows);
                    }
                    if (res && res.count && res.count[0]) {
                        totalCount += res.count[0].n || 0;
                        totalLectures += res.count[0].lectures || 0;
                    }
                    idx++;
                    if (onProgress) onProgress(idx, total);
                    return next();
                });
            }

            return next().then(function () {
                allRows.sort(_sentenceRowCmp);
                var limit = (params && params.$limit) || 500;
                return {
                    rows: allRows.slice(0, limit),
                    count: totalCount,
                    lectures: totalLectures
                };
            });
        });
    }

    /**
     * Run a SQL query. Returns array of objects (sync for fallback, async for Worker).
     * For backward compatibility, this is SYNCHRONOUS in fallback mode.
     * Use queryAsync() for the Promise-based version.
     */
    function queryMeta(sql, params) {
        if (useWorker) {
            throw new Error('Use queryMetaAsync() in Worker mode');
        }
        return runQueryFallback(META, sql, params);
    }

    function queryHtmlTranscripts(lang, sql, params) {
        if (useWorker) {
            throw new Error('Use queryAsync() in Worker mode');
        }
        return runQueryFallback('html_' + (lang || 'en'), sql, params);
    }

    /**
     * Async query — works in both Worker and fallback modes.
     * Returns Promise<Array<Object>>.
     */
    function queryAsync(dbName, sql, params) {
        if (useWorker) {
            return workerCall('query', { dbName: dbName, sql: sql, params: params });
        }
        return new Promise(function (resolve, reject) {
            try {
                resolve(runQueryFallback(dbName, sql, params));
            } catch (err) {
                reject(err);
            }
        });
    }

    function queryMetaAsync(sql, params) {
        return queryAsync(META, sql, params);
    }

    function queryHtmlAsync(lang, sql, params) {
        return queryAsync('html_' + (lang || 'en'), sql, params);
    }

    function querySentencesAsync(sql, params) {
        return queryAsync('sentences_en', sql, params);
    }

    /**
     * Get pre-computed stats from the stats table.
     */
    function getStats() {
        if (useWorker) {
            // Caller should use getStatsAsync() in Worker mode
            throw new Error('Use getStatsAsync() in Worker mode');
        }
        if (!databases[META]) return null;
        try {
            var rows = runQueryFallback(META, 'SELECT key, value FROM stats');
            var stats = {};
            rows.forEach(function (r) { stats[r.key] = r.value; });
            return stats;
        } catch (e) {
            try {
                var countRows = runQueryFallback(META, 'SELECT COUNT(*) as cnt FROM lectures');
                return { total_lectures: countRows[0].cnt };
            } catch (e2) {
                return { total_lectures: 0 };
            }
        }
    }

    function getStatsAsync() {
        return queryAsync(META, 'SELECT key, value FROM stats').then(function (rows) {
            var stats = {};
            rows.forEach(function (r) { stats[r.key] = r.value; });
            return stats;
        }).catch(function () {
            return queryAsync(META, 'SELECT COUNT(*) as cnt FROM lectures').then(function (rows) {
                return { total_lectures: rows[0] ? rows[0].cnt : 0 };
            }).catch(function () {
                return { total_lectures: 0 };
            });
        });
    }

    function isMetaLoaded() {
        return !!loadedDBs[META] || !!databases[META];
    }

    function isHtmlLoaded(lang) {
        var dbName = 'html_' + (lang || 'en');
        return !!loadedDBs[dbName] || !!databases[dbName];
    }

    function isSentencesLoaded() {
        return !!loadedDBs['sentences_en'] || !!databases['sentences_en'];
    }

    /**
     * Check if Worker mode is active.
     */
    function isWorkerMode() {
        return useWorker;
    }

    return {
        initSqlJs: initSqlJs,
        loadMetaDB: loadMetaDB,
        openDBFromGz: openDBFromGz,
        fetchGzDB: fetchGzDB,
        reloadMetaFromStore: reloadMetaFromStore,
        loadHtmlDB: loadHtmlDB,
        loadSentencesDB: loadSentencesDB,
        searchSentencesChunked: searchSentencesChunked,
        // Sync queries (fallback mode only)
        queryMeta: queryMeta,
        queryHtmlTranscripts: queryHtmlTranscripts,
        getStats: getStats,
        // Async queries (both modes)
        queryMetaAsync: queryMetaAsync,
        queryHtmlAsync: queryHtmlAsync,
        querySentencesAsync: querySentencesAsync,
        getStatsAsync: getStatsAsync,
        queryAsync: queryAsync,
        // State checks
        isMetaLoaded: isMetaLoaded,
        isHtmlLoaded: isHtmlLoaded,
        isSentencesLoaded: isSentencesLoaded,
        getDbVersions: getDbVersions,
        isWorkerMode: isWorkerMode
    };
})();
