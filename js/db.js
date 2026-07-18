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
            worker = new Worker('js/db-worker.js?v=cache4');
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
                return loadDB('sentences_en', 'data/ppp_sentences_en.db' + v, progressCallback);
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
        reloadMetaFromStore: reloadMetaFromStore,
        loadHtmlDB: loadHtmlDB,
        loadSentencesDB: loadSentencesDB,
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
