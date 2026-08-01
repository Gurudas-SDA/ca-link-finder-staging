// @ts-check
const { defineConfig } = require('@playwright/test');

// PASTĀVĪGS konfigurācijas fails — daļa no repo, netiek dzēsts pēc lietošanas.
//
// Kāpēc eksistē: deploy/tests/ ir atslēgts orphan (29 novecojuši testi pret
// 111 staging spec testiem) un tajā NEDRĪKST paļauties. staging/tests/ ir
// vienīgā aktuālā testu patiesība šajā projektā — tāpēc arī produkcijas
// pārbaudes vienmēr palaižam no ŠĪ spec (staging/tests/), tikai ar citu
// baseURL, nevis no atsevišķas deploy testu kopijas.
//
// Ko dara: palaiž staging/tests/ testu kopu pret DZĪVU produkciju
// (https://gurudas-sda.github.io/ca-link-finder/) vietā lokālā static
// servera (playwright.config.js), lai verificētu, ka izmaiņas reāli
// nonākušas lietotājiem pēc promote+push.
//
// Kā lieto:
//   npx playwright test --config=playwright.config.prod.js -g "<testa nosaukums>"
//   (vai bez -g, lai palaistu visu kopu pret produkciju)
module.exports = defineConfig({
  testDir: './tests',
  timeout: 90000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'https://gurudas-sda.github.io/ca-link-finder/',
    screenshot: 'only-on-failure',
    trace: 'off',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
