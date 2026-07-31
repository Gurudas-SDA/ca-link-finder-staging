// Static test server for Playwright (S94, 2026-07-07).
// Replaces `python -m http.server` in playwright.config.js: on this machine the
// python server truncates large files (~25 MB meta.db loses its last ~22 KB after
// ~19 s, ERR_CONNECTION_RESET) which made the whole test gate slow and flaky
// (the historic "48 min / 13 of 20 failing" problem, S89). This node server
// serves the same staging root completely and in milliseconds.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const port = Number(process.env.PPP_STATIC_PORT) || 8899;

// --coi: add COOP/COEP so the page becomes `crossOriginIsolated` and can call
// performance.measureUserAgentSpecificMemory() — the ONLY web API that counts
// the Worker isolate and WASM linear memory (performance.memory sees neither).
// OFF by default: the Playwright suite relies on the plain-headers behaviour.
const coi = process.argv.includes('--coi');
const mime = {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.json': 'application/json', '.db': 'application/octet-stream',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
    '.ico': 'image/x-icon', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json'
};

http.createServer(function (req, res) {
    let p;
    try { p = decodeURIComponent(req.url.split('?')[0]); } catch (e) { p = '/'; }
    if (p === '/') p = '/index.html';
    const f = path.normalize(path.join(root, p));
    if (!f.startsWith(root)) { res.writeHead(403); res.end('403'); return; }
    fs.stat(f, function (err, st) {
        if (err || st.isDirectory()) { res.writeHead(404); res.end('404'); return; }
        const headers = {
            'Content-Type': mime[path.extname(f).toLowerCase()] || 'application/octet-stream',
            'Content-Length': st.size,
            'Cache-Control': 'no-store'
        };
        if (coi) {
            headers['Cross-Origin-Opener-Policy'] = 'same-origin';
            headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
            headers['Cross-Origin-Resource-Policy'] = 'same-origin';
        }
        res.writeHead(200, headers);
        fs.createReadStream(f).pipe(res);
    });
}).listen(port, function () {
    console.log('static-server up on http://localhost:' + port + ' (root: ' + root + ')'
        + (coi ? ' [cross-origin isolated]' : ''));
});
