/* ===========================================================================
   PPP Link Finder — SQL.js Web Worker
   Runs all SQLite operations off the main thread to prevent UI freezes.

   Protocol:
     Main → Worker:  { id, cmd, ... }
     Worker → Main:  { id, cmd, result|error, ... }
     Worker → Main:  { cmd:'progress', dbName, progress }  (no id, broadcast)
   =========================================================================== */

var SQL = null;
var databases = {};  // { dbName: SQL.Database }

var WASM_CDN = 'vendor/sql-wasm.wasm';
var SQL_JS_CDN = 'vendor/sql-wasm.js';

// Load sql.js in Worker context
importScripts(SQL_JS_CDN);

/**
 * Initialize sql.js WASM engine.
 */
function initEngine() {
    if (SQL) return Promise.resolve();
    return initSqlJs({
        locateFile: function () { return WASM_CDN; }
    }).then(function (sqlModule) {
        SQL = sqlModule;
    });
}

// Each DB type gets its own cache — so bumping meta doesn't invalidate transcripts
var CACHE_PREFIX = 'ppp-db-';

// Clean up legacy unified cache
if (typeof caches !== 'undefined') {
    caches.keys().then(function (names) {
        names.forEach(function (name) {
            if (name.startsWith('ppp-db-cache-')) {
                caches.delete(name);
            }
        });
    });
}

/**
 * Fetch a DB file with progress reporting, then create SQL.Database.
 * Uses per-DB Cache API with stale-while-revalidate:
 *   - ppp-db-meta (daily updates, ~7MB)
 *   - ppp-db-html_en, ppp-db-html_lv, ppp-db-html_ru (rare updates, 34-49MB each)
 * Background HEAD check detects new versions without re-downloading everything.
 */
function loadDB(dbName, url) {
    var cacheName = CACHE_PREFIX + dbName;
    if (typeof caches !== 'undefined') {
        return caches.open(cacheName).then(function (cache) {
            return cache.match(url).then(function (cachedResponse) {
                if (cachedResponse) {
                    // Cache hit — load from cache (fast)
                    self.postMessage({ cmd: 'progress', dbName: dbName, progress: 0.5 });

                    // Background revalidation via ETag (GitHub Pages provides it)
                    var cachedEtag = cachedResponse.headers.get('x-saved-etag') || '';
                    fetch(url, { method: 'HEAD' }).then(function (headResp) {
                        if (!headResp.ok) return;
                        var serverEtag = headResp.headers.get('etag') || '';
                        if (serverEtag && serverEtag !== cachedEtag) {
                            // Server has newer version — re-download in background
                            fetch(url).then(function (resp) {
                                if (!resp.ok) return;
                                var etag = resp.headers.get('etag') || '';
                                return resp.arrayBuffer().then(function (buf) {
                                    var freshResp = new Response(buf, {
                                        headers: {
                                            'Content-Type': 'application/octet-stream',
                                            'x-saved-etag': etag
                                        }
                                    });
                                    cache.put(url, freshResp);
                                });
                            }).catch(function () { /* silent */ });
                        }
                    }).catch(function () { /* silent — offline is fine */ });

                    return cachedResponse.arrayBuffer().then(function (buf) {
                        self.postMessage({ cmd: 'progress', dbName: dbName, progress: 0.9 });
                        var arr = new Uint8Array(buf);
                        databases[dbName] = new SQL.Database(arr);
                        self.postMessage({ cmd: 'progress', dbName: dbName, progress: 1.0 });
                    });
                }
                // Cache miss — fetch with progress, get ETag via HEAD, then cache
                var currentEtag = '';
                return fetch(url, { method: 'HEAD' }).then(function (h) {
                    currentEtag = (h.ok && h.headers.get('etag')) || '';
                }).catch(function () {}).then(function () {
                    return fetchWithProgress(dbName, url);
                }).then(function (arrayBuffer) {
                    var response = new Response(arrayBuffer, {
                        headers: {
                            'Content-Type': 'application/octet-stream',
                            'x-saved-etag': currentEtag
                        }
                    });
                    cache.put(url, response);
                });
            });
        }).catch(function () {
            return fetchWithProgress(dbName, url);
        });
    }
    return fetchWithProgress(dbName, url);
}

/**
 * Fetch DB with XHR progress reporting and create SQL.Database.
 */
function fetchWithProgress(dbName, url) {
    return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'arraybuffer';

        xhr.onprogress = function (e) {
            if (e.lengthComputable) {
                self.postMessage({ cmd: 'progress', dbName: dbName, progress: e.loaded / e.total });
            }
        };

        xhr.onload = function () {
            if (xhr.status === 200 || xhr.status === 0) {
                try {
                    var arr = new Uint8Array(xhr.response);
                    // This is the heavy operation — runs in Worker, doesn't block UI
                    databases[dbName] = new SQL.Database(arr);
                    resolve(xhr.response);
                } catch (err) {
                    reject(err);
                }
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

/**
 * Open a database from a gzipped ArrayBuffer (offline IDB path).
 * Decompresses inside the Worker with the native DecompressionStream, then
 * builds the SQL.Database off the main thread.
 */
function openGz(dbName, buffer) {
    if (typeof DecompressionStream !== 'function') {
        return Promise.reject(new Error('DecompressionStream unavailable in worker'));
    }
    return new Response(
        new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))
    ).arrayBuffer().then(function (decompressed) {
        databases[dbName] = new SQL.Database(new Uint8Array(decompressed));
    });
}

/**
 * Open a database from an already-decompressed ArrayBuffer (fallback used
 * when the main thread had to decompress because openGz failed here).
 */
function openBuffer(dbName, buffer) {
    databases[dbName] = new SQL.Database(new Uint8Array(buffer));
}

/**
 * Execute a SQL query and return results as array of objects.
 */
function runQuery(dbName, sql, params) {
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

/**
 * Handle messages from main thread.
 */
self.onmessage = function (e) {
    var msg = e.data;
    var id = msg.id;

    switch (msg.cmd) {
        case 'init':
            initEngine().then(function () {
                self.postMessage({ id: id, cmd: 'init', result: true });
            }).catch(function (err) {
                self.postMessage({ id: id, cmd: 'init', error: err.message });
            });
            break;

        case 'loadDB':
            initEngine().then(function () {
                return loadDB(msg.dbName, msg.url);
            }).then(function () {
                self.postMessage({ id: id, cmd: 'loadDB', result: true, dbName: msg.dbName });
            }).catch(function (err) {
                self.postMessage({ id: id, cmd: 'loadDB', error: err.message, dbName: msg.dbName });
            });
            break;

        case 'openGz':
            initEngine().then(function () {
                return openGz(msg.dbName, msg.buffer);
            }).then(function () {
                self.postMessage({ id: id, cmd: 'openGz', result: true, dbName: msg.dbName });
            }).catch(function (err) {
                self.postMessage({ id: id, cmd: 'openGz', error: err.message, dbName: msg.dbName });
            });
            break;

        case 'openBuffer':
            initEngine().then(function () {
                openBuffer(msg.dbName, msg.buffer);
                self.postMessage({ id: id, cmd: 'openBuffer', result: true, dbName: msg.dbName });
            }).catch(function (err) {
                self.postMessage({ id: id, cmd: 'openBuffer', error: err.message, dbName: msg.dbName });
            });
            break;

        case 'query':
            try {
                var rows = runQuery(msg.dbName, msg.sql, msg.params);
                self.postMessage({ id: id, cmd: 'query', result: rows });
            } catch (err) {
                self.postMessage({ id: id, cmd: 'query', error: err.message });
            }
            break;

        case 'isLoaded':
            self.postMessage({ id: id, cmd: 'isLoaded', result: !!databases[msg.dbName] });
            break;
    }
};
