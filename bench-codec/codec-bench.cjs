/* ===========================================================================
   Codec benchmark — gzip (native) vs Brotli (vendored WASM), and the cost of
   the whole-artefact Blob copy that js/codec.js _toStream used to make.

   WHY THIS FILE EXISTS
     The gzip 3824 -> 2203 ms and br 7932 -> 4227 ms figures quoted for the
     2026-07-27 Codex MEDIUM fix were produced by throwaway scripts and never
     saved, so nobody could re-derive them. This script is the durable version:
     it measures BOTH source strategies in ONE run against the CURRENT tree, so
     the "before" number needs no reverted build to reproduce.

       viewStream  = what js/codec.js does now (256 KB subarray views)
       blobStream  = what it did before (new Blob([buf]).stream(), a full copy)

   USAGE
     1. serve staging/ :        node tests/static-server.cjs        (port 8899)
     2. build the fixtures:     node bench-codec/codec-bench.cjs --fixtures
        (decompresses a real shard and re-encodes it with Brotli q11; ~90 s,
         writes bench-codec/fixtures/, which is gitignored-by-convention —
         these are derived artefacts, not sources)
     3. run:                    node bench-codec/codec-bench.cjs
        -> prints a table and writes bench-codec/results-<ISO>.json

   NOT a test. Nothing in the suite depends on it; it exists so a performance
   claim in a review can be checked instead of believed.
   =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const HERE = __dirname;
const STAGING = path.join(HERE, '..');
const FIX = path.join(HERE, 'fixtures');
const PORT = process.env.PPP_STATIC_PORT || 8899;
const SHARD_GZ = path.join(STAGING, 'data', 'shards', 'ppp_sentences_shard_000.db.gz');
const REPEATS = 21;                       // one full sentence search
const BROTLI_QUALITY = 11;                // the production encoder setting

function buildFixtures() {
    if (!fs.existsSync(SHARD_GZ)) {
        throw new Error('No shard to benchmark at ' + SHARD_GZ);
    }
    fs.mkdirSync(FIX, { recursive: true });
    const gz = fs.readFileSync(SHARD_GZ);
    const raw = zlib.gunzipSync(gz);
    process.stdout.write(`raw shard ${raw.length} bytes; brotli q${BROTLI_QUALITY}...`);
    const t = Date.now();
    const br = zlib.brotliCompressSync(raw, {
        params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
        },
    });
    console.log(` ${((Date.now() - t) / 1000).toFixed(1)}s -> ${br.length} bytes`);
    fs.writeFileSync(path.join(FIX, 'shard.db.gz'), gz);
    fs.writeFileSync(path.join(FIX, 'shard.db.br'), br);
    console.log('gz', gz.length, ' br', br.length,
        ' ratio', (br.length / gz.length).toFixed(3));
}

async function run() {
    for (const f of ['shard.db.gz', 'shard.db.br']) {
        if (!fs.existsSync(path.join(FIX, f))) {
            throw new Error('Missing fixture ' + f + ' — run with --fixtures first');
        }
    }
    const { chromium } = require(path.join(STAGING, 'node_modules', 'playwright'));
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('[pageerror]', e.message));

    // Expose the wasm instance so WebAssembly.Memory can be watched directly —
    // performance.memory does not count wasm linear memory or ArrayBuffers.
    await page.addInitScript(() => {
        const orig = WebAssembly.instantiate;
        window.__alloc = 0;
        WebAssembly.instantiate = function (...a) {
            return orig.apply(this, a).then(res => {
                const ex = res.instance.exports;
                if (!ex || !ex.__wbindgen_malloc) return res;
                const w = Object.create(null);
                for (const k of Object.keys(ex)) w[k] = ex[k];
                w.__wbindgen_malloc = function (n, al) {
                    window.__alloc += n;
                    return ex.__wbindgen_malloc(n, al);
                };
                window.__wasm = ex;
                return { instance: { exports: w }, module: res.module };
            });
        };
    });

    await page.goto(`http://localhost:${PORT}/bench-codec/bench.html`);

    const out = await page.evaluate(async (REPEATS) => {
        const MB = n => +(n / 1048576).toFixed(2);
        const med = a => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
        const sum = a => Math.round(a.reduce((x, y) => x + y, 0));

        const gz = await (await fetch('fixtures/shard.db.gz')).arrayBuffer();
        const br = await (await fetch('fixtures/shard.db.br')).arrayBuffer();
        await PPPCodec.loadBrotli();

        // The two source strategies, isolated from everything else.
        const SRC_CHUNK = 256 * 1024;
        function viewStream(buf) {
            const bytes = new Uint8Array(buf);
            let off = 0;
            return new ReadableStream({
                pull(c) {
                    if (off >= bytes.length) { c.close(); return; }
                    const end = Math.min(off + SRC_CHUNK, bytes.length);
                    c.enqueue(bytes.subarray(off, end));
                    off = end;
                },
            });
        }
        const blobStream = buf => new Blob([buf]).stream();

        async function decode(buf, enc, mkStream) {
            const ts = enc === 'br' ? PPPBrotli.stream() : new DecompressionStream('gzip');
            return new Response(mkStream(buf).pipeThrough(ts)).arrayBuffer();
        }

        // Correctness first — a fast wrong answer is not a result.
        const a = new Uint8Array(await decode(gz, 'gzip', viewStream));
        const b = new Uint8Array(await decode(br, 'br', viewStream));
        const identical = a.length === b.length && a.every((v, i) => v === b[i]);

        const r = { identical, rawBytes: a.length, gzBytes: gz.byteLength, brBytes: br.byteLength };

        for (const [name, enc, buf, mk] of [
            ['gzip_view', 'gzip', gz, viewStream],
            ['gzip_blob', 'gzip', gz, blobStream],
            ['br_view', 'br', br, viewStream],
            ['br_blob', 'br', br, blobStream],
        ]) {
            const times = [];
            const alloc0 = window.__alloc;
            for (let i = 0; i < REPEATS; i++) {
                const t = performance.now();
                await decode(buf, enc, mk);
                times.push(performance.now() - t);
            }
            r[name] = {
                medianMs: Math.round(med(times)),
                totalMs: sum(times),
                wasmHeapMB: MB(window.__wasm.memory.buffer.byteLength),
                wasmInputAllocMB: MB(window.__alloc - alloc0),
            };
        }

        // The one-shot footgun, for the record.
        PPPBrotli.decompress(new Uint8Array(br));
        r.wasmHeapAfterOneShotMB = MB(window.__wasm.memory.buffer.byteLength);
        return r;
    }, REPEATS);

    await browser.close();

    out.meta = {
        when: new Date().toISOString(),
        repeats: REPEATS,
        brotliQuality: BROTLI_QUALITY,
        shard: path.basename(SHARD_GZ),
        note: '*_view = js/codec.js as shipped; *_blob = the pre-2026-07-27 full-copy source',
    };
    const file = path.join(HERE, 'results-' + out.meta.when.replace(/[:.]/g, '-') + '.json');
    fs.writeFileSync(file, JSON.stringify(out, null, 2));

    console.log('\nidentical output (gzip vs brotli decode):', out.identical);
    console.log(`shard: ${out.rawBytes} raw / ${out.gzBytes} gz / ${out.brBytes} br\n`);
    console.log('variant     median   total(21)   wasm heap   wasm input alloc');
    for (const k of ['gzip_blob', 'gzip_view', 'br_blob', 'br_view']) {
        const v = out[k];
        console.log(
            k.padEnd(11) + String(v.medianMs + ' ms').padStart(7) +
            String(v.totalMs + ' ms').padStart(11) +
            String(v.wasmHeapMB + ' MB').padStart(12) +
            String(v.wasmInputAllocMB + ' MB').padStart(18));
    }
    console.log('\nwasm heap after ONE one-shot decompress():', out.wasmHeapAfterOneShotMB, 'MB');
    console.log('written:', path.relative(STAGING, file));
}

if (process.argv.includes('--fixtures')) buildFixtures();
else run().catch(e => { console.error(e); process.exit(1); });
