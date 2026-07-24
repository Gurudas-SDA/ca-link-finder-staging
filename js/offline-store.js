/* ===========================================================================
   PPP Link Finder — Offline store (IndexedDB `ca-offline`)
   Single on-device data store for the full offline library. Everything is
   kept gzipped (as Blobs) and decompressed on demand with the native
   DecompressionStream. Two object stores:
     files : { key, packId, gz (Blob), raw }   — keyPath 'key', index 'byPack'
     state : out-of-line keys                  — localManifest, install, ...
   Keys: 't:{lang}:{nr}' premium transcript, 'raw:en:{nr}' raw transcript,
         'core:meta' / 'core:extras' / 'core:sentences' core files.
   =========================================================================== */
window.PPP = window.PPP || {};

PPP.offlineStore = (function () {
    'use strict';

    var DB_NAME = 'ca-offline';
    var DB_VERSION = 1;
    var _dbPromise = null;

    /**
     * Feature check only — never throws. All three are required for the
     * offline path; anything else falls back to the legacy network path.
     */
    function supported() {
        try {
            return !!(window.indexedDB &&
                typeof DecompressionStream === 'function' &&
                navigator.serviceWorker);
        } catch (e) {
            return false;
        }
    }

    function open() {
        if (_dbPromise) return _dbPromise;
        _dbPromise = new Promise(function (resolve, reject) {
            var req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = function (e) {
                var idb = e.target.result;
                if (!idb.objectStoreNames.contains('files')) {
                    var files = idb.createObjectStore('files', { keyPath: 'key' });
                    files.createIndex('byPack', 'packId');
                }
                if (!idb.objectStoreNames.contains('state')) {
                    idb.createObjectStore('state');
                }
            };
            req.onsuccess = function (e) { resolve(e.target.result); };
            req.onerror = function () {
                _dbPromise = null;
                reject(req.error || new Error('IndexedDB open failed'));
            };
        });
        return _dbPromise;
    }

    function _getRecord(key) {
        return open().then(function (idb) {
            return new Promise(function (resolve, reject) {
                var tx = idb.transaction('files', 'readonly');
                var req = tx.objectStore('files').get(key);
                req.onsuccess = function () { resolve(req.result || null); };
                req.onerror = function () { reject(req.error); };
            });
        });
    }

    /**
     * Raw gzipped bytes for a key → ArrayBuffer|null.
     */
    function getGz(key) {
        return _getRecord(key).then(function (rec) {
            if (!rec || !rec.gz) return null;
            return rec.gz.arrayBuffer();
        });
    }

    /**
     * Decompressed text content for a key → string|null.
     */
    function getText(key) {
        return _getRecord(key).then(function (rec) {
            if (!rec || !rec.gz) return null;
            return new Response(
                rec.gz.stream().pipeThrough(new DecompressionStream('gzip'))
            ).text();
        });
    }

    /**
     * Store one file record. Optional `state` = { key, value } is written to
     * the state store in the SAME transaction (atomic resume bookkeeping).
     */
    function putFile(record, state) {
        return open().then(function (idb) {
            return new Promise(function (resolve, reject) {
                var stores = state ? ['files', 'state'] : ['files'];
                var tx = idb.transaction(stores, 'readwrite');
                tx.objectStore('files').put(record);
                if (state) tx.objectStore('state').put(state.value, state.key);
                tx.oncomplete = function () { resolve(); };
                tx.onerror = function () { reject(tx.error); };
                tx.onabort = function () { reject(tx.error || new Error('tx aborted')); };
            });
        });
    }

    /**
     * Replace an entire pack's members atomically: ONE readwrite transaction
     * deletes every record with byPack == packId, then puts all new entries.
     * Optional `state` = { key, value } is committed in the same transaction,
     * so install/resume bookkeeping can never drift from the file records.
     * entries must be fully prepared (Blob slices) BEFORE calling — no async
     * work happens inside the open transaction.
     */
    function applyPack(packId, entries, state) {
        return open().then(function (idb) {
            return new Promise(function (resolve, reject) {
                var stores = state ? ['files', 'state'] : ['files'];
                var tx = idb.transaction(stores, 'readwrite');
                var files = tx.objectStore('files');
                var idx = files.index('byPack');
                var delReq = idx.openCursor(IDBKeyRange.only(packId));
                delReq.onsuccess = function () {
                    var cursor = delReq.result;
                    if (cursor) {
                        cursor.delete();
                        cursor.continue();
                    } else {
                        // Deletes done — put the fresh entries.
                        for (var i = 0; i < entries.length; i++) {
                            files.put({
                                key: entries[i].key,
                                packId: packId,
                                gz: entries[i].gz,
                                raw: entries[i].raw
                            });
                        }
                        if (state) tx.objectStore('state').put(state.value, state.key);
                    }
                };
                tx.oncomplete = function () { resolve(); };
                tx.onerror = function () { reject(tx.error); };
                tx.onabort = function () { reject(tx.error || new Error('tx aborted')); };
            });
        });
    }

    function getState(k) {
        return open().then(function (idb) {
            return new Promise(function (resolve, reject) {
                var tx = idb.transaction('state', 'readonly');
                var req = tx.objectStore('state').get(k);
                req.onsuccess = function () {
                    resolve(req.result === undefined ? null : req.result);
                };
                req.onerror = function () { reject(req.error); };
            });
        });
    }

    function setState(k, v) {
        return open().then(function (idb) {
            return new Promise(function (resolve, reject) {
                var tx = idb.transaction('state', 'readwrite');
                tx.objectStore('state').put(v, k);
                tx.oncomplete = function () { resolve(); };
                tx.onerror = function () { reject(tx.error); };
            });
        });
    }

    function deleteState(k) {
        return open().then(function (idb) {
            return new Promise(function (resolve, reject) {
                var tx = idb.transaction('state', 'readwrite');
                tx.objectStore('state').delete(k);
                tx.oncomplete = function () { resolve(); };
                tx.onerror = function () { reject(tx.error); };
            });
        });
    }

    /**
     * Commit several state writes and deletes in ONE readwrite transaction.
     * `puts` = { key: value } written to the state store, `deletes` = array of
     * state keys removed; either may be omitted or empty. Used for the tails
     * that finish an install or an update, where a half-written group (e.g.
     * `localManifest` stored but `install` not yet deleted, or `langs` still
     * missing) would leave the library describing itself incorrectly after a
     * reload. All-or-nothing: the browser either commits every write or none.
     */
    function commitState(puts, deletes) {
        return open().then(function (idb) {
            return new Promise(function (resolve, reject) {
                var tx = idb.transaction('state', 'readwrite');
                var st = tx.objectStore('state');
                if (puts) {
                    Object.keys(puts).forEach(function (k) { st.put(puts[k], k); });
                }
                if (deletes) {
                    for (var i = 0; i < deletes.length; i++) st.delete(deletes[i]);
                }
                tx.oncomplete = function () { resolve(); };
                tx.onerror = function () { reject(tx.error); };
                tx.onabort = function () { reject(tx.error || new Error('tx aborted')); };
            });
        });
    }

    /**
     * Parse a CAP1 pack: "CAP1" magic (bytes 0-3), uint32 LE index-JSON
     * length (bytes 4-7), index JSON array [{nr, off, len, raw}] sorted by nr,
     * then the blob area (off relative to blob start; each member is a
     * standalone gzip stream). Bounds are validated BEFORE any member Blob is
     * produced — a corrupt pack throws and nothing gets applied.
     * keyFn(nr, member) maps a member to its IDB key.
     * Returns [{ key, gz: Blob, raw }].
     */
    function parsePack(arrayBuffer, keyFn) {
        var view = new DataView(arrayBuffer);
        if (arrayBuffer.byteLength < 8) throw new Error('Pack too small');
        var magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
        if (magic !== 'CAP1') throw new Error('Bad pack magic: ' + magic);
        var indexLen = view.getUint32(4, true);
        var blobStart = 8 + indexLen;
        if (indexLen <= 0 || blobStart > arrayBuffer.byteLength) {
            throw new Error('Bad pack index length: ' + indexLen);
        }
        var indexJson = new TextDecoder().decode(new Uint8Array(arrayBuffer, 8, indexLen));
        var index = JSON.parse(indexJson);
        if (!Array.isArray(index)) throw new Error('Pack index is not an array');
        var blobLen = arrayBuffer.byteLength - blobStart;
        // Validate every member's bounds before slicing anything.
        for (var v = 0; v < index.length; v++) {
            var mv = index[v];
            if (typeof mv.off !== 'number' || typeof mv.len !== 'number' ||
                mv.off < 0 || mv.len < 0 || mv.off + mv.len > blobLen) {
                throw new Error('Pack member out of bounds: nr=' + mv.nr);
            }
        }
        var packBlob = new Blob([arrayBuffer]);
        var entries = [];
        for (var i = 0; i < index.length; i++) {
            var m = index[i];
            entries.push({
                key: keyFn(m.nr, m),
                gz: packBlob.slice(blobStart + m.off, blobStart + m.off + m.len, 'application/gzip'),
                raw: m.raw
            });
        }
        return entries;
    }

    /**
     * Ask the browser to protect the origin's storage from eviction.
     * Fire-and-forget — result is advisory only.
     */
    function requestPersist() {
        try {
            if (navigator.storage && navigator.storage.persist) {
                navigator.storage.persist().catch(function () {});
            }
        } catch (e) { /* advisory only */ }
    }

    return {
        supported: supported,
        open: open,
        getGz: getGz,
        getText: getText,
        putFile: putFile,
        applyPack: applyPack,
        getState: getState,
        setState: setState,
        deleteState: deleteState,
        commitState: commitState,
        parsePack: parsePack,
        requestPersist: requestPersist
    };
})();
