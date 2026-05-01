// @ts-check
const { test, expect } = require('@playwright/test');

// Helper: wait for SQLite to load (progress bar disappears, search input enabled)
async function waitForAppReady(page) {
  // Wait for the search input to become enabled (means DB loaded)
  await page.waitForFunction(() => {
    const input = document.getElementById('searchTerm');
    return input && !input.disabled && input.placeholder && input.placeholder.includes('9');
  }, { timeout: 60000 });
}

// Helper: collect console errors during test
function trackConsoleErrors(page) {
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));
  return errors;
}

test.describe('CA Link Finder — Daily Health Check', () => {

  test('1. App loads and SQLite DB initializes', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('./');

    // Page title
    await expect(page).toHaveTitle(/Chaitanya Academy/);

    // Wait for DB
    await waitForAppReady(page);

    // Search input should have placeholder with lecture count
    const placeholder = await page.locator('#searchTerm').getAttribute('placeholder');
    expect(placeholder).toMatch(/9[,.]?\d{3}/);  // ~9,901 lectures

    // No critical JS errors
    const criticalErrors = errors.filter(e =>
      !e.includes('favicon') && !e.includes('umami') && !e.includes('service-worker')
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test('2. Metadata search returns results', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // Type a common search term
    await page.fill('#searchTerm', 'tattva');
    await page.keyboard.press('Enter');

    // Wait for results
    await page.waitForSelector('#resultsInfo strong', { timeout: 10000 });
    const info = await page.locator('#resultsInfo strong').textContent();
    const count = parseInt(info);
    expect(count).toBeGreaterThan(0);

    // Results table should have rows
    const rows = await page.locator('#resultsTable tbody tr').count();
    expect(rows).toBeGreaterThan(0);
  });

  test('3. Quotes (all) mode — sources panel appears', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // Click Quotes (all) button
    await page.click('.search-mode-btn[data-mode="citations"]');

    // Verse sources panel should appear
    await page.waitForSelector('#verseSourcesList', { state: 'visible', timeout: 10000 });

    // Should contain source names (e.g., Bhagavad-gita)
    const text = await page.locator('#verseSourcesList').textContent();
    expect(text.length).toBeGreaterThan(10);
  });

  test('4. Top 108 — list renders', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // Click Top 108 button
    await page.click('.search-mode-btn[data-mode="citationsTop"]');

    // Wait for topCitationsList to populate
    await page.waitForFunction(() => {
      const list = document.getElementById('topCitationsList');
      return list && list.children.length > 0 && list.querySelectorAll('.recommendation-item').length > 5;
    }, { timeout: 15000 });

    const items = await page.locator('#topCitationsList .recommendation-item').count();
    expect(items).toBeGreaterThanOrEqual(10);
  });

  test('5. Quick action: 20 latest files', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // Click "20 latest" button
    await page.click('button[data-i18n="latest20Files"]');

    // Wait for results
    await page.waitForSelector('#resultsInfo strong', { timeout: 10000 });
    const info = await page.locator('#resultsInfo strong').textContent();
    expect(parseInt(info)).toBe(20);
  });

  test('6. Quick action: 20 latest transcripts', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // Click "20 latest transcripts" button
    await page.click('button[data-i18n="latest20Transcripts"]');

    // Wait for results
    await page.waitForSelector('#resultsInfo strong', { timeout: 10000 });
    const info = await page.locator('#resultsInfo strong').textContent();
    expect(parseInt(info)).toBe(20);
  });

  test('7. Language switch to Russian changes UI', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // Switch to Russian
    await page.click('.lang-btn[data-lang="ru"]');

    // Search placeholder should now be in Russian
    const placeholder = await page.locator('#searchTerm').getAttribute('placeholder');
    expect(placeholder).toMatch(/[а-яА-Я]/);  // Contains Cyrillic
  });

  test('8. Transcript viewer opens', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // Directly invoke the transcript viewer (metadata search links open new tabs,
    // only verse citation results use the in-page viewer)
    await page.evaluate(() => PPP.app.openHtmlTranscriptViewer('455', 'en'));

    // Modal overlay should appear immediately with loading spinner
    await page.waitForSelector('#transcriptModalOverlay.active', { timeout: 10000 });
    const body = page.locator('#transcriptModalBody');
    await expect(body).toBeVisible({ timeout: 5000 });
  });

  test('9. Search with operators: AND (;)', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    await page.fill('#searchTerm', 'guru; tattva');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#resultsInfo strong', { timeout: 10000 });

    const info = await page.locator('#resultsInfo strong').textContent();
    expect(parseInt(info)).toBeGreaterThan(0);
  });

  test('10. Dark mode toggle works', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // Initially body should not have 'dark' class (or have it from prefers-color-scheme)
    const initialDark = await page.evaluate(() => document.body.classList.contains('dark'));

    // Click theme toggle button
    await page.click('#themeToggle');

    // Class should have toggled
    const afterToggle = await page.evaluate(() => document.body.classList.contains('dark'));
    expect(afterToggle).toBe(!initialDark);

    // Toggle back
    await page.click('#themeToggle');
    const afterSecondToggle = await page.evaluate(() => document.body.classList.contains('dark'));
    expect(afterSecondToggle).toBe(initialDark);
  });

  test('11. Favorites — save and show', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // Clear any existing favorites
    await page.evaluate(() => localStorage.removeItem('ppp_collections'));

    // Search to get results with star buttons
    await page.fill('#searchTerm', 'tattva');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.fav-star', { timeout: 10000 });

    // Get first lecture nr and use favorites.toggle() directly
    // (star click opens collections popup which needs extra interaction)
    const nr = await page.locator('.fav-star').first().getAttribute('data-nr');
    await page.evaluate((n) => PPP.favorites.toggle(n), nr);

    // Verify it's saved
    const isFav = await page.evaluate((n) => PPP.favorites.isFavorite(n), nr);
    expect(isFav).toBe(true);

    // Click Favorites button to show saved lectures
    await page.click('#favoritesBtn');

    // Should show at least 1 result
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('#resultsTable tbody tr');
      return rows.length >= 1;
    }, { timeout: 10000 });

    const rows = await page.locator('#resultsTable tbody tr').count();
    expect(rows).toBeGreaterThanOrEqual(1);

    // Clean up
    await page.evaluate(() => localStorage.removeItem('ppp_collections'));
  });

  test('12. Share quote bubble appears on text selection in transcript', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // Open a transcript
    await page.evaluate(() => PPP.app.openHtmlTranscriptViewer('455', 'en'));
    await page.waitForSelector('#transcriptModalOverlay.active', { timeout: 10000 });

    // Wait for transcript content to load
    await page.waitForFunction(() => {
      const body = document.getElementById('transcriptModalBody');
      return body && body.textContent.length > 100;
    }, { timeout: 90000 });

    // Use real mouse to select text — dispatchEvent doesn't trigger addEventListener handlers
    const body = page.locator('#transcriptModalBody');
    const firstP = body.locator('p').first();
    await firstP.waitFor({ timeout: 5000 });
    const box = await firstP.boundingBox();

    if (box) {
      // Click and drag to select text
      await page.mouse.move(box.x + 10, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + Math.min(box.width - 10, 200), box.y + box.height / 2);
      await page.mouse.up();
    }

    // Share bubble should appear (class: transcript-share-bubble)
    await page.waitForSelector('.transcript-share-bubble', { timeout: 5000 });
    const bubble = await page.locator('.transcript-share-bubble').count();
    expect(bubble).toBeGreaterThanOrEqual(1);
  });

  test('13. No critical console errors during full workflow', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('./');
    await waitForAppReady(page);

    // Run through modes
    await page.fill('#searchTerm', 'prema');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);

    await page.locator('.search-mode-btn[data-mode="citations"]').click({ force: true });
    await page.waitForTimeout(2000);

    await page.locator('.search-mode-btn[data-mode="citationsTop"]').click({ force: true });
    await page.waitForTimeout(2000);

    await page.locator('.search-mode-btn[data-mode="metadata"]').click({ force: true });
    await page.waitForTimeout(1000);

    // Filter out non-critical errors
    const critical = errors.filter(e =>
      !e.includes('favicon') &&
      !e.includes('umami') &&
      !e.includes('service-worker') &&
      !e.includes('net::ERR')
    );
    expect(critical).toHaveLength(0);
  });

  test('14. Top combo row has 6 buttons in single row', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    const buttons = page.locator('.search-quick-buttons.main-button-row .combo-btn');
    await expect(buttons).toHaveCount(6);

    const texts = await buttons.allTextContents();
    const joined = texts.join(' | ');
    for (const needle of ['By 2026', 'By Added', 'Top Searches', 'By Verse', 'Verses (Top)', 'Favorites']) {
      expect(joined).toContain(needle);
    }

    const flexWrap = await page.locator('.search-quick-buttons.main-button-row').evaluate(el => getComputedStyle(el).flexWrap);
    expect(flexWrap).toBe('nowrap');
  });

  test('15. By 2026 button exists and is clickable', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('./');
    await waitForAppReady(page);

    const btn = page.locator('.search-quick-buttons.main-button-row .combo-btn', { hasText: 'By 2026' });
    await expect(btn).toBeVisible();
    await btn.click();
    await page.waitForTimeout(500);

    const critical = errors.filter(e =>
      !e.includes('favicon') && !e.includes('umami') && !e.includes('service-worker')
    );
    expect(critical).toHaveLength(0);

    const isFn = await page.evaluate(() => typeof window.PPP?.app?.showBy2026 === 'function');
    expect(isFn).toBe(true);
  });

  test('16. Key Words button is to the left of search input', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    await expect(page.locator('.keywords-search-btn')).toBeVisible();

    const kwBox = await page.locator('.keywords-search-btn').boundingBox();
    const inputBox = await page.locator('#searchTerm').boundingBox();
    expect(kwBox.x).toBeLessThan(inputBox.x);
  });

  test('17. Transcripts & Translations label and 3-button combo present', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    const block = page.locator('.transcripts-block');
    await expect(block).toBeVisible();

    await expect(block).toContainText('Transcripts & Translations');

    const btns = await page.locator('.transcripts-block button').all();
    expect(btns).toHaveLength(3);

    const btnTexts = [];
    for (const b of btns) {
      btnTexts.push((await b.textContent()) || '');
    }
    const joined = btnTexts.join(' | ');
    for (const needle of ['By Date', 'By Topic', 'Newest']) {
      expect(joined).toContain(needle);
    }
  });

});
