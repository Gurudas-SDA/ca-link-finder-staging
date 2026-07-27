/* ===========================================================================
   PPP Link Finder — Artefact codec (gzip | br)
   ---------------------------------------------------------------------------
   WHY
     GitHub Pages sends no `Content-Encoding`, so every artefact (core DBs,
     sentence shards, pack members) is downloaded as opaque BYTES and decoded
     by the app itself. Which codec produced those bytes is therefore OUR
     choice, and since 2026-07-27 the build scripts can produce either:
     `build_sentence_shards.py --encoding br` and
     `build_offline_packs.py --encoding br`.

   THE ONE RULE
     The codec is read PER ENTRY, never from a build-time constant:

       * a manifest ENTRY carries `enc`: "gzip" | "br"
       * an entry WITHOUT `enc` is gzip (every manifest built before the
         option existed, i.e. every manifest any installed device holds today)

     Per entry, not per manifest, because a device legitimately holds a MIXED
     generation: a delta replaces shards one at a time, so mid-update some
     records in IndexedDB are gzip and some are Brotli, and both must decode.

   WHY NOT SNIFF THE BYTES
     gzip starts with 1f 8b. Brotli has NO magic prefix at all — its first
     byte is a bit-packed WBITS field, and 0x1f is a legal value for it
     (low nibble F -> WBITS 24). So "not 1f 8b therefore Brotli" is a guess
     that is wrong in principle even where it happens to hold for our encoder
     (python-brotli's default lgwin 22 emits low nibble B). The offline
     library's correctness must not rest on a coincidence of encoder settings,
     so the codec is DECLARED and carried alongside the bytes — in the
     manifest entry on the network path, on the IndexedDB record itself for
     stored artefacts (offline-store.js writes `enc` next to `gz`).

     The 1f 8b check below is the reverse of a sniff: it never chooses a
     codec, it only refuses bytes that contradict the declared one. That turns
     a broken `enc` hand-off into a named error instead of sql.js being handed
     29 MB of garbage.

   GZIP IS UNTOUCHED
     gzip still goes through the browser's native DecompressionStream. The
     vendored WASM decoder is Brotli-only and is fetched LAZILY — the first
     time a `br` artefact is actually decoded, and never on a gzip-only
     device.
   =========================================================================== */
(function (global) {
    'use strict';

    var GZIP = 'gzip';
    var BR = 'br';

    // Path to the Brotli loader, resolved for BOTH contexts:
    //  - Worker: this file is importScripts()-ed from js/db-worker.js, so a
    //    relative URL resolves against the worker's URL (js/) — the same way
    //    'vendor/sql-wasm.wasm' already does there.
    //  - Window: this file is <script src="js/codec.js">, so take its own
    //    directory from document.currentScript.
    var BROTLI_SRC = (function () {
        try {
            if (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) {
                return document.currentScript.src.replace(/[^/]*$/, '') + 'vendor/brotli-dec.js';
            }
        } catch (e) { /* fall through */ }
        if (typeof document !== 'undefined') return 'js/vendor/brotli-dec.js';
        return 'vendor/brotli-dec.js';
    })();

    /** "gzip" for anything missing or unrecognised — see THE ONE RULE. */
    function normalize(enc) {
        return (enc === BR || enc === 'brotli') ? BR : GZIP;
    }

    /** Does this context have the native gzip decoder at all? */
    function gzipSupported() {
        return typeof DecompressionStream === 'function';
    }

    // ---- Lazy Brotli loading -------------------------------------------------

    var _brotliPromise = null;

    /**
     * Load the Brotli decoder on first use. Idempotent; a failed load is
     * forgotten so a later artefact can retry.
     *
     * NOTE ON "LAZY": this saves the ~208 KB fetch + WASM instantiation on a
     * device whose generation is entirely gzip. It does NOT keep the bytes off
     * the device: the decoder is part of the app SHELL and is precached by the
     * service worker like sql-wasm.wasm, because an INSTALLED (offline) device
     * that then receives a Brotli delta has no network left to fetch a decoder
     * from. Shell cost is one-time and ~0.06 % of a full 342 MB install.
     */
    function loadBrotli() {
        if (global.PPPBrotli && global.PPPBrotli.isReady()) return Promise.resolve();
        if (_brotliPromise) return _brotliPromise;
        _brotliPromise = new Promise(function (resolve, reject) {
            if (global.PPPBrotli) { resolve(); return; }
            if (typeof importScripts === 'function') {
                // Worker: synchronous, no DOM.
                try { importScripts(BROTLI_SRC); resolve(); }
                catch (e) { reject(e); }
                return;
            }
            if (typeof document === 'undefined') {
                reject(new Error('No way to load the Brotli decoder in this context'));
                return;
            }
            var s = document.createElement('script');
            s.src = BROTLI_SRC;
            s.async = true;
            s.onload = function () { resolve(); };
            s.onerror = function () { reject(new Error('Failed to load ' + BROTLI_SRC)); };
            document.head.appendChild(s);
        }).then(function () {
            if (!global.PPPBrotli) throw new Error('Brotli decoder did not register');
            return global.PPPBrotli.load();
        }).catch(function (err) {
            _brotliPromise = null;
            throw err;
        });
        return _brotliPromise;
    }

    /** Is the Brotli decoder already in memory? (Tests / diagnostics.) */
    function brotliReady() {
        return !!(global.PPPBrotli && global.PPPBrotli.isReady());
    }

    // ---- Decoding ------------------------------------------------------------

    /**
     * The decode TransformStream for a codec. gzip resolves immediately with
     * the native stream; br resolves once the WASM decoder is in memory.
     */
    function decodeStream(enc) {
        if (normalize(enc) === BR) {
            return loadBrotli().then(function () { return global.PPPBrotli.stream(); });
        }
        if (!gzipSupported()) {
            return Promise.reject(new Error('DecompressionStream unavailable'));
        }
        return Promise.resolve(new DecompressionStream(GZIP));
    }

    /**
     * Refuse bytes that contradict the DECLARED codec. Only gzip can be
     * checked (Brotli has no magic); only free checks are done (a Blob is not
     * read just to look at two bytes). Never picks a codec — see the header.
     */
    function _assertPlausible(source, enc, whatFor) {
        if (normalize(enc) !== GZIP) return;
        var head = null;
        if (source instanceof ArrayBuffer) {
            if (source.byteLength >= 2) head = new Uint8Array(source, 0, 2);
        } else if (ArrayBuffer.isView(source)) {
            if (source.byteLength >= 2) head = new Uint8Array(source.buffer, source.byteOffset, 2);
        }
        if (head && !(head[0] === 0x1f && head[1] === 0x8b)) {
            throw new Error('Declared gzip but bytes are not gzip' +
                (whatFor ? ' (' + whatFor + ')' : '') +
                ' — first bytes 0x' + head[0].toString(16) + ' 0x' + head[1].toString(16));
        }
    }

    // Source chunk handed to the decoder per pull — same order of magnitude
    // Blob.stream() uses, so decode behaviour does not change.
    var SRC_CHUNK = 256 * 1024;

    /**
     * A ReadableStream over `source`, WITHOUT copying it.
     *
     * A Blob already streams itself. For an ArrayBuffer / TypedArray the old
     * code did `new Blob([source]).stream()` — and that Blob construction
     * copies the WHOLE artefact: 9.1 MB per gzip shard, 21 times per search,
     * on top of the copy the caller is already holding. Handing out subarray
     * VIEWS costs nothing here: nothing mutates the bytes and the decoder
     * consumes each view immediately. (Codex audit MEDIUM, 2026-07-27.)
     *
     * MEASURED, both variants in ONE process (bench-codec/codec-bench.cjs):
     *   wasm heap         12.75 MB -> 8.75 MB
     *   wasm input alloc  443.4 MB -> 132.63 MB per 21-shard search
     *   time              gzip -12 %, brotli -4 %
     * This is a MEMORY fix. The time difference is small and disappears into
     * machine noise — it must not be sold as a speed win. (An earlier claim of
     * -43 %/-55 % came from comparing two SEPARATE runs and was wrong.)
     */
    function _toStream(source) {
        if (source && typeof source.stream === 'function') return source.stream();  // Blob
        var bytes = (source instanceof Uint8Array) ? source
            : ArrayBuffer.isView(source)
                ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
                : new Uint8Array(source);          // view over the ArrayBuffer, not a copy
        var offset = 0;
        return new ReadableStream({
            pull: function (controller) {
                if (offset >= bytes.length) { controller.close(); return; }
                var end = Math.min(offset + SRC_CHUNK, bytes.length);
                controller.enqueue(bytes.subarray(offset, end));
                offset = end;
            }
        });
    }

    /**
     * Decode `source` (Blob | ArrayBuffer | TypedArray) → ArrayBuffer.
     * Streaming on purpose: the decoder never holds the whole input and the
     * whole output at once. Measured on a 29.6 MB sentence shard, desktop
     * Chrome: streaming leaves the WASM heap at 8.75 MB and flat across
     * repeats, while a one-shot decode grows it to 77.06 MB permanently
     * (WebAssembly.Memory cannot shrink). Same shape the gzip path already
     * had, so peak memory does not move.
     */
    function toArrayBuffer(source, enc, whatFor) {
        try { _assertPlausible(source, enc, whatFor); }
        catch (e) { return Promise.reject(e); }
        return decodeStream(enc).then(function (ts) {
            return new Response(_toStream(source).pipeThrough(ts)).arrayBuffer();
        });
    }

    /** Same, decoded as UTF-8 text (transcript HTML, extras JSON). */
    function toText(source, enc, whatFor) {
        try { _assertPlausible(source, enc, whatFor); }
        catch (e) { return Promise.reject(e); }
        return decodeStream(enc).then(function (ts) {
            return new Response(_toStream(source).pipeThrough(ts)).text();
        });
    }

    var api = {
        GZIP: GZIP,
        BR: BR,
        normalize: normalize,
        gzipSupported: gzipSupported,
        brotliReady: brotliReady,
        loadBrotli: loadBrotli,
        decodeStream: decodeStream,
        toArrayBuffer: toArrayBuffer,
        toText: toText
    };

    global.PPPCodec = api;
    if (typeof window !== 'undefined') {
        window.PPP = window.PPP || {};
        window.PPP.codec = api;
    }
})(typeof self !== 'undefined' ? self : this);
