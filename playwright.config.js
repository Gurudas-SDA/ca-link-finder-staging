// @ts-check
const { defineConfig } = require('@playwright/test');

// baseURL points at a LOCAL server (this staging dir) instead of the
// gurudas-sda.github.io/ca-link-finder-staging/ GitHub Pages URL — that repo
// is private, and the free plan does not publish Pages for private repos, so
// the remote URL 404s permanently (discovered S89, 2026-07-03). Testing
// against a local server is also faster and does not depend on network/CDN.
module.exports = defineConfig({
  testDir: './tests',
  timeout: 90000,         // local disk I/O for large DB/JSON files is slower than a CDN
  retries: 1,             // Retry once on failure (I/O flakiness)
  reporter: [['list'], ['json', { outputFile: 'test-results.json' }]],
  use: {
    baseURL: 'http://localhost:8899/',
    screenshot: 'only-on-failure',
    trace: 'off',
  },
  webServer: {
    command: 'python -m http.server 8899',
    port: 8899,
    reuseExistingServer: true,
    timeout: 60000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
