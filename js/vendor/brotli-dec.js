/* ===========================================================================
   Brotli decoder — loader + minimal wasm-bindgen glue (HAND-WRITTEN)
   ---------------------------------------------------------------------------
   WHY THIS FILE EXISTS
     GitHub Pages sends no `Content-Encoding`, so the app downloads its
     artefacts as opaque BYTES and decodes them itself. The browser's native
     DecompressionStream knows 'gzip' / 'deflate' / 'deflate-raw' and NOT
     'br' (verified Chrome 145: "Unsupported compression format: 'br'"), so a
     Brotli generation of the corpus needs a decoder shipped with the app.

   WHAT IS VENDORED
     ONLY the binary `brotli-dec.wasm` — brotli_dec_wasm_bg.wasm from
     brotli-dec-wasm@2.3.2 (MIT OR Apache-2.0, https://github.com/
     ustclug-dev/brotli-dec-wasm, a Rust `brotli-decompressor` build).
     sha256 79b29cb1790560f0a0f32b4a31d935e2782875e4a367fde23c81d986b327ec3f
     208 439 bytes. DECOMPRESSION ONLY — the module exports no compressor.

     The upstream JS glue is NOT vendored. It is minified ESM that uses
     `import.meta.url`, so it cannot be `importScripts`-ed into the classic
     dedicated Worker where the hot path lives — and a minified third-party
     blob is exactly the thing a supply-chain review cannot read. The glue
     below is written here instead: ~6 KB of readable ES5 implementing the six
     imports the module asks for and the two calls we use.

   WHAT IT EXPOSES  (global, same name in Window and Worker scope)
     PPPBrotli.load()        -> Promise, idempotent, instantiates the wasm
     PPPBrotli.isReady()     -> bool
     PPPBrotli.stream()      -> TransformStream, drop-in for
                                new DecompressionStream('gzip')
     PPPBrotli.decompress(u8)-> Uint8Array (one-shot; small payloads only)

   MEMORY — MEASURED, and the reason stream() exists
     Decoding the same real 29.6 MB sentence shard 21 times (one full search's
     worth) in desktop Chrome, watching the WebAssembly.Memory buffer:
       stream()      8.75 MB, FLAT across all 21 decodes
       decompress()  jumps to ~77 MB on the FIRST call and stays there
     WebAssembly.Memory cannot shrink, so the one-shot number is not a peak,
     it is a permanent session cost — it holds the whole input and the whole
     output inside wasm at once. stream() feeds the decoder one source chunk
     at a time and hands each output chunk straight to the consumer, which is
     the same shape the gzip path already had. Large artefacts must use it.

   SPEED — MEASURED (same shard, desktop Chrome, medians of 21)
       gzip, native DecompressionStream   114 ms
       br,   this decoder via stream()    225 ms   (~2x)
     Output verified byte-identical to the gzip decode of the same shard.
     Reproduce with bench-codec/codec-bench.cjs; results-*.json sits next to
     it. Absolute numbers move a great deal with machine load, so only ever
     compare variants measured in the SAME process — which is exactly what
     that script does, after two cross-run comparisons produced a speed claim
     that a controlled A/B did not support.
   =========================================================================== */
(function (global) {
    'use strict';

    var WASM_FILE = 'brotli-dec.wasm';

    // Output buffer handed to the decoder per call. Large enough that a 30 MB
    // shard costs ~30 chunk round-trips instead of thousands, small enough
    // that the transient copy is irrelevant next to the artefact itself.
    // It also has to stay COMFORTABLY LARGER than the decompressed size of one
    // source chunk (codec.js SRC_CHUNK, 256 KB). When a chunk expands past this
    // budget the decoder returns NeedsMoreOutput and the remaining input is
    // re-offered — which re-allocates it, because the wasm side took ownership
    // of the previous copy. At 1 MB against 256 KB of source that never
    // happens on real shards: measured input allocation across a 21-shard
    // search is 132.63 MB for 132.6 MB of input, i.e. each byte handed over
    // exactly once. (Before the source chunking was fixed it was 443.4 MB —
    // 3.3x the input — all of it churn.)
    var OUT_CHUNK = 1024 * 1024;

    var wasm = null;          // instantiated exports
    var loadPromise = null;

    /* ---- Where is the .wasm? ------------------------------------------------
     * Worker:  this file was importScripts()-ed from js/db-worker.js, so a
     *          plain relative URL resolves against the WORKER's URL (js/) —
     *          exactly how sql-wasm.wasm is already located there.
     * Window:  document.currentScript.src gives this file's absolute URL at
     *          script-evaluation time; take its directory. Falls back to the
     *          known layout if currentScript is unavailable (deferred/async
     *          injection edge cases).
     */
    var BASE = (function () {
        try {
            if (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) {
                return document.currentScript.src.replace(/[^/]*$/, '');
            }
        } catch (e) { /* fall through */ }
        if (typeof document !== 'undefined') return 'js/vendor/';
        return 'vendor/';
    })();

    // ---- wasm-bindgen support plumbing -------------------------------------
    // The module uses the externref-table ABI: JS values it wants to keep are
    // parked in an exported table and read back by index.

    var _memU8 = null;
    function u8() {
        if (_memU8 === null || _memU8.byteLength === 0) _memU8 = new Uint8Array(wasm.memory.buffer);
        return _memU8;
    }
    var _memView = null;
    function view() {
        if (_memView === null || _memView.buffer !== wasm.memory.buffer) {
            _memView = new DataView(wasm.memory.buffer);
        }
        return _memView;
    }

    var _dec = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
    var _enc = new TextEncoder();

    /** Read a (ptr,len) UTF-8 string out of wasm memory. */
    function readStr(ptr, len) {
        return _dec.decode(u8().subarray(ptr >>> 0, (ptr >>> 0) + len));
    }

    /** Copy a JS string INTO wasm memory; returns [ptr, len]. */
    function writeStr(s) {
        var bytes = _enc.encode(s);
        var ptr = wasm.__wbindgen_malloc(bytes.length, 1) >>> 0;
        u8().set(bytes, ptr);
        return [ptr, bytes.length];
    }

    /* Copy bytes INTO wasm memory; returns the pointer.
     *
     * THE CALLER MUST NOT FREE THIS. It reads like a leak and is not — that
     * was raised as a supply-chain finding on 2026-07-27 and settled by
     * measurement, so the answer lives here instead of the next reader
     * repeating the investigation.
     *
     * The exports take their input BY VALUE (`Vec<u8>`), not by borrow
     * (`&[u8]`). The Rust side reconstructs the Vec from this pointer, owns it
     * and drops it — on the success path AND on the error path, because the
     * value was moved in before anything could fail. A __wbindgen_free() here
     * would be a DOUBLE FREE, not a fix. Upstream's own glue frees only the
     * OUTPUT at all four of its call sites and never the input, for exactly
     * this reason.
     *
     * MEASURED (desktop Chrome, real 6.46 MB Brotli shard):
     *   21 streaming decodes            -> WebAssembly.Memory flat at 8.75 MB
     *   200 corrupt streaming decodes   -> no growth at all  (error path)
     *   200 corrupt one-shot decodes    -> no growth at all  (error path)
     *   CONTROL: 21 deliberate __wbindgen_malloc() with NO free
     *                                   -> +129.9 MB
     * The control is the point: an unfreed input IS visible, by ~130 MB.
     * It is not there, so nothing is leaking — on either path.
     *
     * What that measurement DID expose is allocation CHURN — a chunk that
     * overflows the output budget gets re-offered and each retry re-allocates
     * the remaining input. See OUT_CHUNK. */
    function writeBytes(bytes) {
        var ptr = wasm.__wbindgen_malloc(bytes.length, 1) >>> 0;
        u8().set(bytes, ptr);
        return ptr;
    }

    /** Take a JS value the module parked in the externref table, and free the
     *  slot. Used only on the error path (the thrown Error object). */
    function takeRef(idx) {
        var v = wasm.__wbindgen_externrefs.get(idx);
        wasm.__externref_table_dealloc(idx);
        return v;
    }

    /* The six imports the module declares. Five of them exist purely to build
     * and report Rust panics / decoder errors; only the table initialiser runs
     * on the happy path. The mangled names are part of the binary's ABI and
     * must match brotli-dec.wasm exactly — they change if the .wasm is ever
     * re-vendored, which is intentional: a mismatched pair fails loudly at
     * instantiation instead of silently misbehaving. */
    function importObject() {
        return {
            './brotli_dec_wasm_bg.js': {
                __wbg_new_227d7c05414eb861: function () { return new Error(); },
                __wbg_Error_83742b46f01ce22d: function (p, l) { return Error(readStr(p, l)); },
                __wbg___wbindgen_throw_6ddd609b62940d55: function (p, l) {
                    throw new Error(readStr(p, l));
                },
                __wbg_error_a6fa202b58aa1cd3: function (p, l) {
                    try { console.error(readStr(p, l)); }
                    finally { wasm.__wbindgen_free(p, l, 1); }
                },
                __wbg_stack_3b0d974bbf31e44f: function (retPtr, errObj) {
                    var pair = writeStr(String((errObj && errObj.stack) || ''));
                    view().setInt32(retPtr + 4, pair[1], true);
                    view().setInt32(retPtr + 0, pair[0], true);
                },
                __wbindgen_init_externref_table: function () {
                    var t = wasm.__wbindgen_externrefs;
                    var offset = t.grow(4);
                    t.set(0, undefined);
                    t.set(offset + 0, undefined);
                    t.set(offset + 1, null);
                    t.set(offset + 2, true);
                    t.set(offset + 3, false);
                }
            }
        };
    }

    // ---- Loading ------------------------------------------------------------

    /**
     * Fetch + instantiate the decoder. Idempotent: repeated calls share one
     * promise, and a FAILED load is forgotten so a later attempt can retry
     * (an install that races the service worker must not be poisoned by one
     * transient miss).
     */
    function load() {
        if (wasm) return Promise.resolve();
        if (loadPromise) return loadPromise;
        var url = BASE + WASM_FILE;
        loadPromise = Promise.resolve().then(function () {
            // instantiateStreaming needs the right MIME type; not every static
            // host sends application/wasm, so go through arrayBuffer, which is
            // universally correct and costs milliseconds on a 208 KB module.
            return fetch(url).then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status + ' loading ' + url);
                return r.arrayBuffer();
            }).then(function (buf) {
                return WebAssembly.instantiate(buf, importObject());
            }).then(function (res) {
                wasm = res.instance.exports;
                _memU8 = null;
                _memView = null;
                wasm.__wbindgen_start();
            });
        }).catch(function (err) {
            loadPromise = null;
            throw new Error('Brotli decoder failed to load: ' + ((err && err.message) || err));
        });
        return loadPromise;
    }

    function isReady() { return !!wasm; }

    function ensure() {
        if (!wasm) throw new Error('Brotli decoder not loaded — call PPPBrotli.load() first');
    }

    // ---- Decoding -----------------------------------------------------------

    var CODE_SUCCESS = 1;
    var CODE_NEED_INPUT = 2;
    var CODE_NEED_OUTPUT = 3;

    /** Thin handle over one Rust DecompressStream. */
    function Stream() {
        ensure();
        this.ptr = wasm.decompressstream_new() >>> 0;
        this.done = false;
    }

    /**
     * Feed one input chunk, collect every output chunk it produces.
     * Returns an array of Uint8Array (each already copied out of wasm memory,
     * so it stays valid when the wasm heap grows).
     */
    Stream.prototype.push = function (chunk) {
        // Bytes after the decoder already reported the stream complete mean the
        // artefact is not what its manifest entry says it is (concatenated or
        // corrupt). Say so rather than silently dropping them.
        if (this.done) throw new Error('Trailing bytes after the end of a Brotli stream');
        var out = [];
        var offset = 0;
        var code;
        do {
            // The Rust side consumes from the START of what it is given, and
            // reports how much it took, so the remainder is re-offered as a
            // subarray — a VIEW, not a copy.
            var slice = offset ? chunk.subarray(offset) : chunk;
            var inPtr = writeBytes(slice);
            var ret = wasm.decompressstream_decompress(this.ptr, inPtr, slice.length, OUT_CHUNK);
            if (ret[2]) throw takeRef(ret[1]);
            var resPtr = ret[0] >>> 0;
            var bufPair = wasm.__wbg_get_brotlistreamresult_buf(resPtr);
            var bufPtr = bufPair[0] >>> 0, bufLen = bufPair[1];
            if (bufLen) out.push(u8().subarray(bufPtr, bufPtr + bufLen).slice());
            wasm.__wbindgen_free(bufPtr, bufLen, 1);
            code = wasm.__wbg_get_brotlistreamresult_code(resPtr);
            offset += wasm.__wbg_get_brotlistreamresult_input_offset(resPtr) >>> 0;
            wasm.__wbg_brotlistreamresult_free(resPtr, 0);
            if (code === CODE_SUCCESS) { this.done = true; break; }
            if (code !== CODE_NEED_INPUT && code !== CODE_NEED_OUTPUT) {
                throw new Error('Brotli decode failed with code ' + code);
            }
            // NeedsMoreInput with the chunk not fully consumed would spin
            // forever; treat it as "this chunk is finished".
            if (code === CODE_NEED_INPUT) break;
        } while (offset < chunk.length || code === CODE_NEED_OUTPUT);
        return out;
    };

    Stream.prototype.free = function () {
        if (this.ptr) { wasm.__wbg_decompressstream_free(this.ptr, 0); this.ptr = 0; }
    };

    /**
     * A TransformStream that decodes Brotli — the drop-in shape of
     * `new DecompressionStream('gzip')`, so call sites keep reading
     *     new Response(blob.stream().pipeThrough(X)).arrayBuffer()
     * unchanged whichever codec an artefact uses.
     */
    function stream() {
        ensure();
        var s = new Stream();
        return new TransformStream({
            transform: function (chunk, controller) {
                var parts = s.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
                for (var i = 0; i < parts.length; i++) controller.enqueue(parts[i]);
            },
            flush: function (controller) {
                try {
                    // Truncated input: the decoder never reported success, so
                    // the artefact is incomplete. Fail loudly — a short buffer
                    // handed to sql.js is a much worse failure mode.
                    if (!s.done) controller.error(new Error('Truncated Brotli stream'));
                } finally { s.free(); }
            }
        });
    }

    /**
     * One-shot decode. Sanity-check / small-payload API only, and NOT used by
     * any app path: it holds the whole input and the whole output inside wasm
     * at once, which measured 77.06 MB of WebAssembly.Memory for one 29.6 MB
     * shard — permanently, since that memory cannot be given back. Everything
     * in the app goes through stream() (8.75 MB, flat). See the header.
     */
    function decompress(bytes) {
        ensure();
        var input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        var inPtr = writeBytes(input);
        var ret = wasm.decompress(inPtr, input.length);
        if (ret[3]) throw takeRef(ret[2]);
        var outPtr = ret[0] >>> 0, outLen = ret[1];
        var out = u8().subarray(outPtr, outPtr + outLen).slice();
        wasm.__wbindgen_free(outPtr, outLen, 1);
        return out;
    }

    global.PPPBrotli = {
        load: load,
        isReady: isReady,
        stream: stream,
        decompress: decompress
    };
})(typeof self !== 'undefined' ? self : this);
