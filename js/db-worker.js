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

// Artefact codec (gzip native / Brotli WASM). Tiny and always needed; the
// Brotli decoder itself is NOT loaded here — codec.js pulls it in with its own
// importScripts the first time a `br` artefact actually arrives, so a gzip-only
// device never instantiates it.
importScripts('codec.js');

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
 * Open a database from a COMPRESSED ArrayBuffer (offline IDB path).
 * Decompresses inside the Worker — gzip through the native
 * DecompressionStream, Brotli through the vendored WASM decoder — then builds
 * the SQL.Database off the main thread. `enc` is the codec the caller read
 * from the artefact's manifest entry / IndexedDB record; missing means gzip.
 */
function openGz(dbName, buffer, enc) {
    if (PPPCodec.normalize(enc) === 'gzip' && !PPPCodec.gzipSupported()) {
        return Promise.reject(new Error('DecompressionStream unavailable in worker'));
    }
    return PPPCodec.toArrayBuffer(buffer, enc, dbName).then(function (decompressed) {
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
 * Run one prepared statement on a specific SQL.Database handle.
 */
function runQueryOn(db, sql, params) {
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
 * Execute a SQL query against a named, resident DB and return array of objects.
 */
function runQuery(dbName, sql, params) {
    var db = databases[dbName];
    if (!db) throw new Error('Database "' + dbName + '" not loaded');
    return runQueryOn(db, sql, params);
}

/**
 * Build a SQL.Database from an already-decompressed buffer, run the query
 * (and optional count query), dispose the handle, and return the rows.
 * The handle is NEVER stored in `databases` — so no shard leaks across calls;
 * peak memory stays at one shard. Returns { rows, count }.
 */
function queryCloseBuffer(buffer, sql, countSql, params) {
    var db = new SQL.Database(new Uint8Array(buffer));
    try {
        var out = { rows: runQueryOn(db, sql, params) };
        out.count = countSql ? runQueryOn(db, countSql, params) : null;
        return out;
    } finally {
        db.close();
    }
}

/**
 * Decompress a compressed shard buffer inside the Worker, then run + dispose
 * via queryCloseBuffer (one-shard-resident invariant). Returns { rows, count }.
 * `enc` comes from the shard's own manifest/IndexedDB record, so a search that
 * crosses a half-applied delta decodes gzip and Brotli shards in the same loop.
 */
function openQueryClose(gzBuffer, sql, countSql, params, enc) {
    if (PPPCodec.normalize(enc) === 'gzip' && !PPPCodec.gzipSupported()) {
        return Promise.reject(new Error('DecompressionStream unavailable in worker'));
    }
    return PPPCodec.toArrayBuffer(gzBuffer, enc, 'shard').then(function (decompressed) {
        return queryCloseBuffer(decompressed, sql, countSql, params);
    });
}

/**
 * Reject a call AND hand the source bytes back to the main thread.
 *
 * The main thread used to keep a whole second copy of every compressed
 * artefact (`gzArrayBuffer.slice(0)`) purely so its fallback chain would still
 * have one after transferring the first — 9.1 MB per gzip shard, 21 shards per
 * search, on the one budget this app cannot spare. Returning the bytes on the
 * failure path removes that copy entirely, and costs nothing: the decoder only
 * ever read VIEWS of this buffer, so it is still intact here.
 * (Codex audit MEDIUM, 2026-07-27.)
 *
 * Transferring it back also detaches it here, which is what we want — the
 * worker has no further use for a call that just failed.
 */
function failWithBuffer(id, cmd, err, buffer, extra) {
    var msg = { id: id, cmd: cmd, error: (err && err.message) || String(err) };
    if (extra) { for (var k in extra) msg[k] = extra[k]; }
    if (buffer && buffer.byteLength) {
        msg.buffer = buffer;
        self.postMessage(msg, [buffer]);
    } else {
        self.postMessage(msg);
    }
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
                return openGz(msg.dbName, msg.buffer, msg.enc);
            }).then(function () {
                self.postMessage({ id: id, cmd: 'openGz', result: true, dbName: msg.dbName });
            }).catch(function (err) {
                failWithBuffer(id, 'openGz', err, msg.buffer, { dbName: msg.dbName });
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

        case 'openQueryClose':
            // Chunked shard search: decompress (per-shard codec) → open →
            // query → dispose.
            // Only ONE shard DB exists at a time (never stored in `databases`).
            initEngine().then(function () {
                return openQueryClose(msg.buffer, msg.sql, msg.countSql, msg.params, msg.enc);
            }).then(function (res) {
                self.postMessage({ id: id, cmd: 'openQueryClose', result: res });
            }).catch(function (err) {
                failWithBuffer(id, 'openQueryClose', err, msg.buffer);
            });
            break;

        case 'queryCloseBuffer':
            // Fallback: main thread already decompressed → open → query → dispose.
            initEngine().then(function () {
                var res = queryCloseBuffer(msg.buffer, msg.sql, msg.countSql, msg.params);
                self.postMessage({ id: id, cmd: 'queryCloseBuffer', result: res });
            }).catch(function (err) {
                self.postMessage({ id: id, cmd: 'queryCloseBuffer', error: err.message });
            });
            break;

        case 'isLoaded':
            self.postMessage({ id: id, cmd: 'isLoaded', result: !!databases[msg.dbName] });
            break;
    }
};
