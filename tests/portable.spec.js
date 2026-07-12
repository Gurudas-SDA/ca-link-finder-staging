// @ts-check
// Smoke test for the PORTABLE offline build (portable-build/CA-Portable/).
// Proves the self-contained folder works with NO internet:
//   - launches the portable server with the BUNDLED node.exe (runtime/node.exe),
//   - loads the app, asserts the title,
//   - asserts NO request hits cdnjs.cloudflare.com or cdn.sheetjs.com (offline
//     vendoring: sql.js / xlsx are served from app/vendor/, not a CDN),
//   - waits for the SQLite DB, runs a real live-search for "Krishna" and asserts
//     result rows render.
// Generated alongside scripts/build_portable.py (Versija A portable build).
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORTABLE_ROOT = path.join(__dirname, '..', '..', 'portable-build', 'CA-Portable');
const BUNDLED_NODE = path.join(PORTABLE_ROOT, 'runtime', 'node.exe');
const PORTABLE_SERVER = path.join(PORTABLE_ROOT, 'server', 'static-server.cjs');

// Prefer the bundled node.exe (proves the portable runtime works); fall back to
// system `node` if the bundle is missing for any reason.
const nodeBin = fs.existsSync(BUNDLED_NODE) ? BUNDLED_NODE : 'node';

let serverProc;
let baseUrl;

// Launch the portable server and capture the actual URL/port it prints to stdout.
// The portable server picks a free port starting at 8899; because Playwright's
// own webServer already holds 8899, this instance lands on 8900+ — so we must
// use the URL it reports, not a hard-coded port.
test.beforeAll(async () => {
  await new Promise((resolve, reject) => {
    serverProc = spawn(nodeBin, [PORTABLE_SERVER], {
      cwd: path.join(PORTABLE_ROOT, 'server'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      reject(new Error('Portable server did not print its URL within 30s'));
    }, 30000);

    let out = '';
    serverProc.stdout.on('data', (chunk) => {
      out += chunk.toString();
      const m = out.match(/http:\/\/localhost:(\d+)\//);
      if (m && !baseUrl) {
        baseUrl = m[0];
        clearTimeout(timer);
        resolve();
      }
    });
    serverProc.on('error', (e) => { clearTimeout(timer); reject(e); });
    serverProc.on('exit', (code) => {
      if (!baseUrl) { clearTimeout(timer); reject(new Error('Portable server exited early (code ' + code + ')')); }
    });
  });
});

test.afterAll(() => {
  if (serverProc && !serverProc.killed) serverProc.kill();
});

// Wait for SQLite to load: search input becomes enabled with a lecture-count
// placeholder (mirrors app.spec.js waitForAppReady).
async function waitForAppReady(page) {
  await page.waitForFunction(() => {
    const input = document.getElementById('searchTerm');
    return input && !input.disabled && input.placeholder && input.placeholder.includes('9');
  }, { timeout: 60000 });
}

test.describe('CA-Portable — offline build smoke test', () => {

  test('portable build loads, is fully offline-vendored, and search works', async ({ page }) => {
    expect(baseUrl, 'portable server URL captured from stdout').toBeTruthy();

    // Record any request that reaches a forbidden CDN host. If offline vendoring
    // is correct, this list must stay empty.
    const cdnHits = [];
    page.on('request', (req) => {
      const u = req.url();
      if (u.includes('cdnjs.cloudflare.com') || u.includes('cdn.sheetjs.com')) {
        cdnHits.push(u);
      }
    });

    await page.goto(baseUrl);

    // 1) Title proves the app HTML loaded from the portable server.
    await expect(page).toHaveTitle(/Chaitanya Academy/);

    // 2) DB must initialise fully offline.
    await waitForAppReady(page);

    // 3) No CDN requests at all — sql.js / xlsx are vendored locally.
    expect(cdnHits, 'no requests to cdnjs.cloudflare.com / cdn.sheetjs.com').toEqual([]);

    // 4) Real search. This build wires the search to the Enter keydown on the
    //    input (app.js: searchInput.addEventListener('keydown', ... e.key==='Enter'
    //    -> doSearch()), not to a live 'input' event. So type the term and press
    //    Enter, exactly like a user — same mechanism app.spec.js test 2 uses.
    await page.fill('#searchTerm', 'Krishna');
    await page.locator('#searchTerm').press('Enter');

    // Result rows must render (a data row has >= 3 <td> cells). Krishna yields
    // ~400 matches, so results WILL appear.
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('#resultsTable tbody tr');
      let dataRows = 0;
      rows.forEach((tr) => { if (tr.querySelectorAll('td').length >= 3) dataRows++; });
      return dataRows > 0;
    }, { timeout: 15000 });

    const dataRowCount = await page.evaluate(() => {
      const rows = document.querySelectorAll('#resultsTable tbody tr');
      let n = 0;
      rows.forEach((tr) => { if (tr.querySelectorAll('td').length >= 3) n++; });
      return n;
    });
    expect(dataRowCount).toBeGreaterThan(0);
  });

});
