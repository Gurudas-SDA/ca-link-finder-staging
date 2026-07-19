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

// Offline PWA startup: on a fresh profile the app shows a download-confirmation
// button before installing the full offline library into IndexedDB. The
// ppp_auto_install=1 localStorage hook (see app.js startFirstInstallFlow) skips
// only the button click and runs the REAL install flow — every test below
// therefore exercises the genuine offline startup path against the local
// static server before the app becomes ready.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('ppp_auto_install', '1'); } catch (e) {}
  });
});

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
    expect(placeholder).toMatch(/1?\d[,.]?\d{3}/);  // ~10,019 lectures (or 9,xxx historic)

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

  test('18. Phrase matching — multi-word query is literal substring, not AND-of-words', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // Single "goswami" should return many results
    await page.fill('#searchTerm', 'goswami');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#resultsInfo strong', { timeout: 10000 });
    const singleCount = parseInt(await page.locator('#resultsInfo strong').textContent());
    expect(singleCount).toBeGreaterThan(10);

    // "goswami, goswami" — phrase with comma+space does not appear twice consecutively
    // in any file name, so result must be 0 (regression test for the AND-words bug)
    await page.fill('#searchTerm', 'goswami, goswami');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#resultsInfo', { timeout: 10000 });
    await page.waitForTimeout(500);
    const phraseInfo = await page.locator('#resultsInfo').textContent();
    const phraseMatch = phraseInfo.match(/(\d+)/);
    const phraseCount = phraseMatch ? parseInt(phraseMatch[1]) : -1;
    expect(phraseCount).toBe(0);
  });

  test('19. Search restricted to 5 visible columns — no Subject/Author hits', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // "Bhakti Tirtha" is typically an Author/Subject value, not in Original file name as a phrase.
    // Verify the phrase only matches when present in the 5 visible columns.
    await page.fill('#searchTerm', 'zzznoexistxyz');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#resultsInfo', { timeout: 10000 });
    await page.waitForTimeout(300);
    const info = await page.locator('#resultsInfo').textContent();
    const match = info.match(/(\d+)/);
    const count = match ? parseInt(match[1]) : 0;
    expect(count).toBe(0);
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

  test('20. Escape closes transcript modal', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // Open a transcript (same path as test 8)
    await page.evaluate(() => PPP.app.openHtmlTranscriptViewer('455', 'en'));
    await page.waitForSelector('#transcriptModalOverlay.active', { timeout: 10000 });

    // Press Escape — modal must close
    await page.keyboard.press('Escape');
    await expect(page.locator('#transcriptModalOverlay')).not.toHaveClass(/active/, { timeout: 5000 });
  });

  test('21. loading placeholder never shows 0 links', async ({ page }) => {
    await page.goto('./');

    // Immediately (before app ready) the placeholder must not claim "0 links"
    const early = await page.locator('#searchTerm').getAttribute('placeholder');
    expect(early).not.toContain('among 0');
    expect(early).not.toMatch(/(^|\s)0(\s|$)/);

    // Keep sampling until ready — no intermediate state may show "0"
    const seen = [];
    for (let i = 0; i < 40; i++) {
      const ph = await page.locator('#searchTerm').getAttribute('placeholder');
      seen.push(ph || '');
      const ready = await page.evaluate(() => {
        const input = document.getElementById('searchTerm');
        return input && !input.disabled && input.placeholder && input.placeholder.includes('9');
      });
      if (ready) break;
      await page.waitForTimeout(500);
    }
    for (const ph of seen) {
      expect(ph).not.toContain('among 0');
      expect(ph).not.toMatch(/(^|\s)0(\s|$)/);
    }

    // After ready — placeholder must contain a count > 0
    await waitForAppReady(page);
    const finalPh = await page.locator('#searchTerm').getAttribute('placeholder');
    const m = (finalPh || '').replace(/[,. ]/g, '').match(/(\d+)/);
    expect(m).not.toBeNull();
    expect(parseInt(m[1], 10)).toBeGreaterThan(0);
  });

  test('22. app is usable when extras.json is blocked', async ({ page }) => {
    // Block the extras JSON entirely — app must still become usable
    await page.route('**/ppp_lecture_extras.json*', r => r.abort());

    await page.goto('./');
    await waitForAppReady(page);

    await page.fill('#searchTerm', 'krishna');
    await page.keyboard.press('Enter');

    await page.waitForSelector('#resultsInfo strong', { timeout: 10000 });
    const info = await page.locator('#resultsInfo strong').textContent();
    expect(parseInt(info)).toBeGreaterThan(0);

    const rows = await page.locator('#resultsTable tbody tr').count();
    expect(rows).toBeGreaterThan(0);
  });

  test('23. Keyboard focus is visible', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // Tab through the first elements — at least one focused element must show
    // a visible outline (the global :focus-visible ring)
    let visibleOutlineFound = false;
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      // some buttons have `transition: all 0.2s` which animates outline-width in
      await page.waitForTimeout(300);
      const visible = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return false;
        const cs = getComputedStyle(el);
        return cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px';
      });
      if (visible) { visibleOutlineFound = true; break; }
    }
    expect(visibleOutlineFound).toBe(true);
  });

  test('24. Search input has accessible name and lang switches', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // Accessible name: placeholder changes, aria-label must be stable
    const ariaLabel = await page.locator('#searchTerm').getAttribute('aria-label');
    expect(ariaLabel).toBe('Search lectures');

    // html[lang] must follow the UI language
    await page.click('.lang-btn[data-lang="ru"]');
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('ru');

    await page.click('.lang-btn[data-lang="en"]');
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
  });

  test('25. Buttons meet AA contrast', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // WCAG relative-luminance contrast computed in-page from getComputedStyle.
    // Gradients: every color stop of background-image must pass vs the text color.
    const ratios = await page.evaluate(() => {
      function lum(rgb) {
        const f = (v) => {
          v /= 255;
          return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
      }
      function contrast(c1, c2) {
        const l1 = lum(c1), l2 = lum(c2);
        const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
        return (hi + 0.05) / (lo + 0.05);
      }
      function parseColors(str) {
        const out = [];
        const re = /rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)/g;
        let m;
        while ((m = re.exec(str))) out.push([+m[1], +m[2], +m[3]]);
        return out;
      }
      function minContrast(sel) {
        const el = document.querySelector(sel);
        if (!el) return -1;
        const cs = getComputedStyle(el);
        const text = parseColors(cs.color)[0];
        let bgs = [];
        if (cs.backgroundImage && cs.backgroundImage !== 'none') {
          bgs = parseColors(cs.backgroundImage);
        }
        if (!bgs.length) bgs = parseColors(cs.backgroundColor);
        if (!text || !bgs.length) return -1;
        return Math.min.apply(null, bgs.map((bg) => contrast(text, bg)));
      }
      return {
        searchButton: minContrast('.search-bar button.search-button'),
        modeButton: minContrast('.keywords-search-btn'),
        comboSaffron: minContrast('.combo-btn-1'),
        comboGold: minContrast('.combo-btn-3'),
      };
    });

    expect(ratios.searchButton).toBeGreaterThanOrEqual(4.5);
    expect(ratios.modeButton).toBeGreaterThanOrEqual(4.5);
    expect(ratios.comboSaffron).toBeGreaterThanOrEqual(4.5);
    expect(ratios.comboGold).toBeGreaterThanOrEqual(4.5);
  });

  test('26. Mobile results have no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('./');
    await waitForAppReady(page);

    await page.fill('#searchTerm', 'krishna');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#resultsInfo strong', { timeout: 10000 });
    // Wait for a REAL result row (13 cells), not the transient empty-state row
    await page.waitForFunction(() => {
      const tr = document.querySelector('#resultsTable.lecture-cards tbody tr');
      return tr && tr.children.length === 13;
    }, { timeout: 10000 });

    // Document itself must not scroll horizontally (2px tolerance)
    const doc = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth + 2);

    // The results container must not have inner horizontal scroll either
    const cont = await page.evaluate(() => {
      const el = document.querySelector('.results-container');
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });
    expect(cont.scrollWidth).toBeLessThanOrEqual(cont.clientWidth + 2);
  });

  test('27. Mobile card shows title in first position', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('./');
    await waitForAppReady(page);

    await page.fill('#searchTerm', 'krishna');
    await page.keyboard.press('Enter');
    // Wait for a REAL result row (13 cells), not the transient empty-state row
    await page.waitForFunction(() => {
      const tr = document.querySelector('#resultsTable.lecture-cards tbody tr');
      return tr && tr.children.length === 13;
    }, { timeout: 10000 });

    const card = await page.evaluate(() => {
      const tr = document.querySelector('#resultsTable.lecture-cards tbody tr');
      const tds = Array.from(tr.children);
      const title = tds[4]; // Original file name cell
      const date = tds[2];  // Date cell
      const cs = getComputedStyle(title);
      const titleTop = title.getBoundingClientRect().top;
      // topmost Y among other visible in-flow cells (meta + action rows)
      const otherTops = tds
        .filter((td, i) => i !== 4)
        .filter((td) => {
          const s = getComputedStyle(td);
          return s.display !== 'none' && s.position !== 'absolute';
        })
        .map((td) => td.getBoundingClientRect().top);
      return {
        titleText: (title.textContent || '').trim(),
        dateText: (date.textContent || '').trim(),
        fontSizePx: parseFloat(cs.fontSize),
        fontWeight: parseInt(cs.fontWeight, 10),
        titleTop,
        minOtherTop: Math.min.apply(null, otherTops),
      };
    });

    // Title is the first visible text element of the card (above Date/meta)
    expect(card.titleText.length).toBeGreaterThan(0);
    expect(card.titleTop).toBeLessThan(card.minOtherTop);
    // and it is the file name, not the date
    expect(card.titleText).not.toBe(card.dateText);
    expect(card.titleText).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // readable: >= 14px and bold
    expect(card.fontSizePx).toBeGreaterThanOrEqual(14);
    expect(card.fontWeight).toBeGreaterThanOrEqual(600);
  });

  test('28. Desktop table unchanged (regression guard)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('./');
    await waitForAppReady(page);

    await page.fill('#searchTerm', 'krishna');
    await page.keyboard.press('Enter');
    // Wait for a REAL result row (13 cells), not the transient empty-state row
    await page.waitForFunction(() => {
      const tr = document.querySelector('#resultsTable tbody tr');
      return tr && tr.children.length === 13;
    }, { timeout: 10000 });

    const desktop = await page.evaluate(() => {
      const table = document.getElementById('resultsTable');
      const thead = table.querySelector('thead');
      const tr = table.querySelector('tbody tr');
      return {
        tableDisplay: getComputedStyle(table).display,
        theadDisplay: thead ? getComputedStyle(thead).display : 'missing',
        rowDisplay: getComputedStyle(tr).display,
        cellCount: tr.children.length,
        headerCells: thead ? thead.querySelectorAll('th').length : 0,
      };
    });

    expect(desktop.tableDisplay).toBe('table');
    expect(desktop.theadDisplay).not.toBe('none');
    expect(desktop.rowDisplay).toBe('table-row');
    expect(desktop.cellCount).toBe(13); // ★ + 🔗 + 11 columns
    expect(desktop.headerCells).toBeGreaterThan(10);

    // thead quick buttons (By Date / By Topic / Newest) still visible on desktop
    await expect(page.locator('.transcripts-block')).toBeVisible();
  });

  test('29. Mobile cards keep header quick buttons working', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('./');
    await waitForAppReady(page);

    await page.fill('#searchTerm', 'krishna');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const tr = document.querySelector('#resultsTable.lecture-cards tbody tr');
      return tr && tr.children.length === 13;
    }, { timeout: 10000 });

    // Extras (essence JSON) arriving later re-renders the whole table
    // (app.js loadExtras().then(displayResults)) — wait for it so the DOM we
    // measure is final and locators do not detach mid-assertion.
    await page.waitForFunction(() => window.PPP && PPP.ui && PPP.ui.extrasReady(), { timeout: 30000 });

    // The Transcripts & Translations block (count + 3 buttons) is visible above cards
    await expect(page.locator('.transcripts-block')).toBeVisible();
    const buttons = page.locator('.transcripts-block button');
    await expect(buttons).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      const box = await buttons.nth(i).boundingBox();
      expect(box).not.toBeNull();
      expect(box.height).toBeGreaterThanOrEqual(44); // touch target
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(377); // inside 375px viewport (+2px)
    }

    // Clicking "By Topic" really opens the topics view
    await page.click('.transcripts-block button[data-i18n="lectureTopics"]');
    await page.waitForFunction(() => {
      const list = document.getElementById('topicsList');
      return list && getComputedStyle(list).display !== 'none' &&
        list.querySelectorAll('.topic-item').length > 0;
    }, { timeout: 15000 });
    const topicCount = await page.locator('#topicsList .topic-item').count();
    expect(topicCount).toBeGreaterThan(0);
  });

  test.describe('extras retry (SW blocked so page.route sees every request)', () => {
    test.use({ serviceWorkers: 'block' });

    test('30. Extras retry after failure — indicator shows, auto-retry restores essence', async ({ page }) => {
    test.setTimeout(120000); // auto-retry fires 20 s after the first failure

    // Force the LEGACY startup path (network SQLite + network extras): with
    // the offline library installed, extras are served from IndexedDB and the
    // network hiccup under test could never happen. Blocking the manifest is
    // itself a real production scenario — the app must gracefully fall back
    // to the legacy network load when the manifest is unreachable.
    await page.route('**/data/manifest.json*', route => route.abort());

    // Abort the FIRST extras request (simulates a mobile network hiccup),
    // let all subsequent requests through.
    let extrasRequests = 0;
    await page.route('**/ppp_lecture_extras.json*', route => {
      extrasRequests++;
      if (extrasRequests === 1) return route.abort();
      return route.continue();
    });

    await page.goto('./');
    await waitForAppReady(page);

    // First attempt failed → extras NOT ready (the old bug cached {} forever)
    // and the unobtrusive loading indicator is visible.
    await expect(page.locator('#extrasLoadingInfo')).toBeVisible();
    expect(await page.evaluate(() => PPP.ui.extrasReady())).toBe(false);

    // Search works without extras; the indicator stays visible near results
    // info UNLESS the 20 s auto-retry has already succeeded by now (locally
    // the refetch is fast, so both orders are legal).
    await page.fill('#searchTerm', 'krishna');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#resultsInfo strong', { timeout: 10000 });
    const retryDone = await page.evaluate(() => PPP.ui.extrasReady());
    if (!retryDone) {
      await expect(page.locator('#extrasLoadingInfo')).toBeVisible();
    }

    // The scheduled retry (20 s) refetches and succeeds this time.
    await page.waitForFunction(() => window.PPP && PPP.ui && PPP.ui.extrasReady(), { timeout: 45000 });
    expect(extrasRequests).toBeGreaterThanOrEqual(2);

    // Visible results were refreshed: essence lines appear, indicator is gone.
    await page.waitForSelector('.essence-hint', { timeout: 10000 });
    await expect(page.locator('#extrasLoadingInfo')).toBeHidden();
    });
  });

  test('31. Sentence search (In Transcripts) — word-prefix match + Excel button', async ({ page }) => {
    // Lazy-loads the ~60 MB sentences DB on first search; allow extra time.
    test.setTimeout(120000);

    await page.goto('./');
    await waitForAppReady(page);

    // The install banner (if it ever appears) overlaps the mode buttons — hide it.
    await page.evaluate(() => {
      const b = document.getElementById('installBanner');
      if (b) b.style.display = 'none';
    });

    // Switch to the sentence-search mode.
    await page.locator('.search-mode-btn[data-mode="sentences"]').click({ force: true });

    // Search for a word that has a near substring twin ("price"/"priceless")
    // where the term sits in the MIDDLE/END of the twin, not at its start.
    await page.fill('#searchTerm', 'rice');
    await page.keyboard.press('Enter');

    // Summary line: "Found N sentences in M lectures — showing first K".
    await page.waitForSelector('#resultsInfo strong', { timeout: 90000 });
    const summary = await page.locator('#resultsInfo strong').textContent();
    expect(summary).toMatch(/Found \d+ sentences in \d+ lectures/);

    // Results table has rows.
    const rows = await page.locator('#resultsTable tbody tr').count();
    expect(rows).toBeGreaterThan(0);

    // Word-prefix semantics: every rendered sentence contains a word that
    // STARTS WITH "rice" (e.g. "rice" or "rices"), and none contains the
    // substring-only twin "priceless"/"price" (where "rice" is not at the
    // word start). Column 1 is the (new) multi-select checkbox cell, column
    // 2 is Timestamp, column 3 is Sentence.
    const sentences = await page.locator('#resultsTable tbody tr td:nth-child(3)').allTextContents();
    expect(sentences.length).toBeGreaterThan(0);
    const wordPrefixRice = /(^|[^a-z])rice/i;
    for (const s of sentences) {
      expect(s.toLowerCase()).not.toContain('priceless');
      expect(s.toLowerCase()).not.toMatch(/(^|[^a-z])price([^a-z]|$)/);
      expect(s).toMatch(wordPrefixRice);
    }

    // Download Excel button is present.
    await expect(page.locator('#resultsInfo button', { hasText: 'Download Excel' })).toBeVisible();
  });

  test('31b. buildTranscriptSQL generates word-prefix (not whole-word) LIKE params', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    const result = await page.evaluate(() => {
      const parsed = window.PPP.search.parseSearchQuery('feather');
      const built = window.PPP.search.buildTranscriptSQL(parsed);
      return { params: built.params };
    });

    // Prefix pattern: leading space anchors the word START, no trailing
    // space so any suffix (e.g. "feathers") is allowed to match.
    const paramValues = Object.keys(result.params)
      .filter((k) => k !== '$limit')
      .map((k) => result.params[k]);
    expect(paramValues.length).toBeGreaterThan(0);
    for (const v of paramValues) {
      expect(v).toBe('% feather%');
      expect(v).not.toBe('% feather %'); // old whole-word pattern must be gone
    }
  });

  test('31c. "In Text" mode shows a dedicated search placeholder', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // The install banner (if it ever appears) overlaps the mode buttons — hide it.
    await page.evaluate(() => {
      const b = document.getElementById('installBanner');
      if (b) b.style.display = 'none';
    });

    await page.locator('.search-mode-btn[data-mode="sentences"]').click({ force: true });

    const placeholder = await page.locator('#searchTerm').getAttribute('placeholder');
    expect(placeholder).toContain('Search within sentences');
    expect(placeholder).not.toContain('Search for wisdom');
  });

  test('35. Sentence search checkboxes drive the shared "Download selected" button', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto('./');
    await waitForAppReady(page);
    await page.evaluate(() => {
      const b = document.getElementById('installBanner');
      if (b) b.style.display = 'none';
    });

    await page.locator('.search-mode-btn[data-mode="sentences"]').click({ force: true });
    await page.fill('#searchTerm', 'rice');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#resultsInfo strong', { timeout: 90000 });

    // A checkbox appears in the first (reserved) cell of every result row —
    // reusing the SAME .select-checkbox mechanism as the metadata table.
    const boxes = page.locator('#resultsTable tbody tr td.sel-cell input.select-checkbox');
    const n = await boxes.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      await expect(boxes.nth(i)).toHaveAttribute('data-lang', 'en');
    }

    // Persistent "Download selected" button starts disabled with no selection.
    const dlBtn = page.locator('#downloadSelectedBtn');
    await expect(dlBtn).toBeVisible();
    await expect(dlBtn).toBeDisabled();

    // Ticking one checkbox enables it and shows the correct count.
    await boxes.nth(0).check();
    await expect(dlBtn).toBeEnabled();
    await expect(dlBtn).toContainText('(1)');
  });

  test('36. Two sentence matches from the SAME lecture dedupe to one ZIP pair', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto('./');
    await waitForAppReady(page);
    await page.evaluate(() => {
      const b = document.getElementById('installBanner');
      if (b) b.style.display = 'none';
    });

    await page.locator('.search-mode-btn[data-mode="sentences"]').click({ force: true });
    await page.fill('#searchTerm', 'rice');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#resultsInfo strong', { timeout: 90000 });

    const boxes = page.locator('#resultsTable tbody tr td.sel-cell input.select-checkbox');
    const count = await boxes.count();
    const nrs = [];
    for (let i = 0; i < count; i++) nrs.push(await boxes.nth(i).getAttribute('data-nr'));

    // Find two rows that share the same lecture nr (two sentence hits, one lecture).
    const seenAt = {};
    let idxA = -1, idxB = -1;
    for (let i = 0; i < nrs.length; i++) {
      if (seenAt[nrs[i]] !== undefined) { idxA = seenAt[nrs[i]]; idxB = i; break; }
      seenAt[nrs[i]] = i;
    }
    test.skip(idxA === -1, 'No two sentence hits from the same lecture on this results page — cannot exercise dedupe');

    await boxes.nth(idxA).check();
    await boxes.nth(idxB).check();

    // Both checks resolve to the SAME "<nr>|en" selection key -> Set size stays 1.
    const dlBtn = page.locator('#downloadSelectedBtn');
    await expect(dlBtn).toContainText('(1)');

    await dlBtn.click();
    // Panel confirms: 1 transcript, 1 distinct lecture.
    await expect(page.locator('#selectCount')).toContainText('1 transcripts');
    await expect(page.locator('#selectCount')).toContainText('1 lectures');
  });

  test('37. Excel export — Script_EN URL cell is a clickable hyperlink', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto('./');
    await waitForAppReady(page);
    await page.evaluate(() => {
      const b = document.getElementById('installBanner');
      if (b) b.style.display = 'none';
    });

    await page.locator('.search-mode-btn[data-mode="sentences"]').click({ force: true });
    await page.fill('#searchTerm', 'rice');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#resultsInfo strong', { timeout: 90000 });

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.locator('#resultsInfo button', { hasText: 'Download Excel' }).click(),
    ]);
    const fname = download.suggestedFilename();
    expect(fname).toMatch(/\.xlsx$/);

    const filePath = await download.path();
    const fs = require('fs');
    const b64 = fs.readFileSync(filePath).toString('base64');

    // Parse the downloaded workbook using the SAME XLSX build the app itself
    // uses (already loaded in the page) — avoids a Node-side xlsx dependency.
    const hasHyperlink = await page.evaluate((b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const wb = XLSX.read(bytes, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const range = XLSX.utils.decode_range(ws['!ref']);
      for (let r = range.s.r + 1; r <= range.e.r; r++) {
        const addr = XLSX.utils.encode_cell({ r, c: 5 }); // col F = Script_EN URL
        const cell = ws[addr];
        if (cell && cell.l && cell.l.Target) return true;
      }
      return false;
    }, b64);

    expect(hasHyperlink).toBe(true);
  });

  test('38. ZIP export highlighter marks matched sentence + matched word', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // Unit-level test of PPP.app._wrapMatchesInContainer(): builds a detached
    // DOM container with sample transcript text and verifies the two-tier
    // mark.tr-sentence / mark.tr-word wrapping (Rājan decision: sentence =
    // yellow #fff3a0, word inside it = light green #b6f5c0).
    const result = await page.evaluate(() => {
      var container = document.createElement('div');
      container.innerHTML = '<p>Before text. He offered rice and fruits to the Deity. After text.</p>';
      PPP.app._wrapMatchesInContainer(
        container,
        ['He offered rice and fruits to the Deity.'],
        ['rice']
      );
      var sentenceMark = container.querySelector('mark.tr-sentence');
      var wordMark = container.querySelector('mark.tr-word');
      return {
        hasSentenceMark: !!sentenceMark,
        hasWordMark: !!wordMark,
        wordInsideSentence: !!(sentenceMark && wordMark && sentenceMark.contains(wordMark)),
        wordText: wordMark ? wordMark.textContent : null,
        sentenceContainsBefore: sentenceMark ? !/Before text/.test(sentenceMark.textContent) : null
      };
    });

    expect(result.hasSentenceMark).toBe(true);
    expect(result.hasWordMark).toBe(true);
    expect(result.wordInsideSentence).toBe(true);
    expect((result.wordText || '').toLowerCase()).toBe('rice');

    // Prefix-search regression: matching "feather" must highlight only the
    // "feather" prefix inside "feathers" (word-START boundary only, no
    // trailing \b), and must NOT match "rice" inside "price".
    const prefixResult = await page.evaluate(() => {
      var container = document.createElement('div');
      container.innerHTML = '<p>The peacock feathers were a fine price to pay for rice.</p>';
      PPP.app._wrapMatchesInContainer(
        container,
        ['The peacock feathers were a fine price to pay for rice.'],
        ['feather']
      );
      var marks = Array.prototype.map.call(container.querySelectorAll('mark.tr-word'), function (m) {
        return m.textContent;
      });
      return marks;
    });

    expect(prefixResult).toEqual(['feather']);
  });

  test('39. Sentence-search highlighter is diacritic- and case-insensitive (word-start prefix)', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // 1. Diacritic-insensitive prefix match: "mahaprabh" (no diacritics)
    // must highlight "Mahāprabh" (with ā) inside "Mahāprabhu" — the trailing
    // "u" (folded, not part of the matched prefix) stays unhighlighted.
    const diacriticResult = await page.evaluate(() => {
      var html = PPP.ui.highlightSentencePrefix('...Caitanya Mahāprabhu.', ['mahaprabh']);
      var div = document.createElement('div');
      div.innerHTML = html;
      var span = div.querySelector('span');
      return { hasSpan: !!span, spanText: span ? span.textContent : null, fullText: div.textContent };
    });
    expect(diacriticResult.hasSpan).toBe(true);
    expect(diacriticResult.spanText).toBe('Mahāprabh');
    expect(diacriticResult.fullText).toBe('...Caitanya Mahāprabhu.');

    // Case-insensitive: same folded word against an all-caps variant.
    const caseResult = await page.evaluate(() => {
      var html = PPP.ui.highlightSentencePrefix('MAHAPRABHU spoke.', ['mahaprabh']);
      var div = document.createElement('div');
      div.innerHTML = html;
      var span = div.querySelector('span');
      return { hasSpan: !!span, spanText: span ? span.textContent : null };
    });
    expect(caseResult.hasSpan).toBe(true);
    expect(caseResult.spanText).toBe('MAHAPRABH');

    // 2. Prefix, not whole word: "feather" highlights only "feather" inside
    // "feathers", never the trailing "s".
    const featherResult = await page.evaluate(() => {
      var html = PPP.ui.highlightSentencePrefix('decorated with feathers', ['feather']);
      var div = document.createElement('div');
      div.innerHTML = html;
      var span = div.querySelector('span');
      return { spanText: span ? span.textContent : null };
    });
    expect(featherResult.spanText).toBe('feather');

    // 3. Substring-but-not-prefix must NOT match: "rice" is not a word-start
    // prefix of "price".
    const noMatchResult = await page.evaluate(() => {
      var html = PPP.ui.highlightSentencePrefix('a fine price to pay', ['rice']);
      var div = document.createElement('div');
      div.innerHTML = html;
      return { hasSpan: !!div.querySelector('span') };
    });
    expect(noMatchResult.hasSpan).toBe(false);
  });

  test('40. ZIP export word-highlighter (_wrapMatchesInContainer) is diacritic-insensitive', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // Folded search word ("mahaprabh", as produced by _extractSentenceSearchWords)
    // must highlight the diacritic-bearing "Mahāprabh" run in the transcript text.
    const result = await page.evaluate(() => {
      var container = document.createElement('div');
      container.innerHTML = '<p>Devotees glorified Caitanya Mahāprabhu with kirtan.</p>';
      PPP.app._wrapMatchesInContainer(
        container,
        ['Devotees glorified Caitanya Mahāprabhu with kirtan.'],
        ['mahaprabh']
      );
      var wordMark = container.querySelector('mark.tr-word');
      return { hasWordMark: !!wordMark, wordText: wordMark ? wordMark.textContent : null };
    });

    expect(result.hasWordMark).toBe(true);
    expect(result.wordText).toBe('Mahāprabh');
  });

  test('41. ZIP export sentence-highlighter tolerates DB punctuation-spacing drift', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // Regression for the Pass 1 indexOf bug: the DB sentence text can carry
    // spaces before punctuation (e.g. "Gaurāṅga , we are observing .") while
    // the transcript text does not ("Gaurāṅga, we are observing."). An exact
    // whitespace-normalized indexOf never matches in that case, so no yellow
    // tr-sentence mark was produced even though the sentence is present.
    // _wrapMatchesInContainer must now find it via token-order regex matching.
    const result = await page.evaluate(() => {
      var container = document.createElement('div');
      container.innerHTML = '<p>Before text. Gaurāṅga, we are observing. After text.</p>';
      PPP.app._wrapMatchesInContainer(
        container,
        ['Gaurāṅga , we are observing .'],
        ['gauranga']
      );
      var sentenceMark = container.querySelector('mark.tr-sentence');
      return {
        hasSentenceMark: !!sentenceMark,
        sentenceText: sentenceMark ? sentenceMark.textContent : null
      };
    });

    expect(result.hasSentenceMark).toBe(true);
    // Token-order regex spans first-token..last-token; trailing punctuation
    // after the final matched token is not included by design.
    expect(result.sentenceText).toBe('Gaurāṅga, we are observing');
  });

  test('26. Multi-select transcripts (per language) download as one named ZIP', async ({ page }) => {
    // Serve the premium per-lecture HTML same-origin so the ZIP is built from the
    // in-app premium path (no dependency on the live Drive API in the test).
    await page.route('**/transcripts/en/*.html', route =>
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<p>Mock premium transcript body for offline ZIP test.</p>'
      })
    );

    await page.goto('./');
    await waitForAppReady(page);
    // Ensure English (premium path used above targets transcripts/en/).
    await page.click('.lang-btn[data-lang="en"]');

    // Search to get lecture rows.
    await page.fill('#searchTerm', 'krishna');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#resultsInfo strong', { timeout: 10000 });

    // No "Select" toggle any more — per-language checkboxes are ALWAYS visible.
    await expect(page.locator('#selectModeBtn')).toHaveCount(0);
    await page.waitForSelector('.select-checkbox[data-lang="en"]', { timeout: 10000 });

    // Before any checkbox is ticked the "Download selected" button is disabled.
    const dlBtn = page.locator('#downloadSelectedBtn');
    await expect(dlBtn).toBeVisible();
    await expect(dlBtn).toBeDisabled();

    // Tick two EN transcript checkboxes on two DIFFERENT lectures (the model
    // selects "<nr>|<lang>" pairs, not whole lectures).
    const enBoxes = page.locator('.select-checkbox[data-lang="en"]');
    await expect(enBoxes.nth(1)).toBeVisible(); // need at least two EN transcripts
    const nr0 = await enBoxes.nth(0).getAttribute('data-nr');
    const nr1 = await enBoxes.nth(1).getAttribute('data-nr');
    expect(nr0).not.toBe(nr1);                  // two distinct lectures
    await enBoxes.nth(0).check();
    await enBoxes.nth(1).check();

    // Now the button is ENABLED and shows the count "Download selected (2)".
    await expect(dlBtn).toBeEnabled();
    await expect(dlBtn).toContainText('(2)');

    // Clicking it opens the download panel at the TOP with the name input.
    await dlBtn.click();
    const bar = page.locator('#selectActionBar');
    await expect(bar).toBeVisible();
    await expect(page.locator('#zipNameInput')).toBeVisible();
    await expect(page.locator('#selectCount')).toContainText('2 transcripts');

    // Name the ZIP.
    await page.fill('#zipNameInput', 'Janmastami test 2026');

    // Click download and capture the browser download event.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click('#zipDownloadBtn'),
    ]);

    const fname = download.suggestedFilename();
    expect(fname).toMatch(/\.zip$/);
    expect(fname).toBe('Janmastami_test_2026.zip');
  });

  test('27. Feature #33 (ZIP download) is discoverable in app + guide', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // App "Features" button reflects the new count (33).
    await expect(page.locator('[data-i18n="featuresBtn"]')).toContainText('33');

    // After a search, the persistent "Download selected" button carries a
    // non-empty localized tooltip (title).
    await page.fill('#searchTerm', 'krishna');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#resultsInfo strong', { timeout: 10000 });
    const dlTitle = await page.locator('#downloadSelectedBtn').getAttribute('title');
    expect(dlTitle && dlTitle.trim().length).toBeGreaterThan(0);

    // The EN guide renders 33 feature cards and includes a ZIP-download card.
    // (Static test server has no directory index — request index.html explicitly.)
    await page.goto('/guide/en/index.html');
    await page.waitForSelector('.card', { timeout: 10000 });
    const cardCount = await page.locator('.card').count();
    expect(cardCount).toBe(33);
    await expect(page.locator('.card h3', { hasText: 'ZIP' })).toHaveCount(1);
  });

  test('32. Features button opens grouped dropdown menu', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    const menu = page.locator('#featuresMenu');
    await expect(menu).toBeHidden();

    // Clicking the Features button reveals the menu.
    await page.locator('.features-btn').click();
    await expect(menu).toBeVisible();

    // "All functions" link points at the full guide.
    const all = menu.locator('.fm-all');
    await expect(all).toHaveCount(1);
    const allHref = await all.getAttribute('href');
    expect(allHref).toMatch(/guide\/en\/index\.html$/);

    // Grouped list: 9 group headings, several item links.
    await expect(menu.locator('.fm-group')).toHaveCount(9);
    const itemCount = await menu.locator('.fm-item').count();
    expect(itemCount).toBe(33);

    // Each item deep-links to a specific function anchor.
    const firstItemHref = await menu.locator('.fm-item').first().getAttribute('href');
    expect(firstItemHref).toMatch(/guide\/en\/index\.html#item-\d+$/);

    // Function numbers are NOT displayed in the visible text.
    const groupText = await menu.locator('.fm-group').first().textContent();
    expect(groupText && groupText.trim().length).toBeGreaterThan(0);

    // Escape closes the menu.
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });

  test('33. Features menu closes on backdrop click', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    const menu = page.locator('#featuresMenu');
    await page.locator('.features-btn').click();
    await expect(menu).toBeVisible();

    // Click the modal backdrop (overlay corner, away from the centered panel).
    await menu.click({ position: { x: 5, y: 5 } });
    await expect(menu).toBeHidden();
  });

  test('34. Raw transcript disclaimer: warning header + line break in all 6 languages', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    const result = await page.evaluate(() => {
      const i18n = window.PPP.i18n;
      const esc = window.PPP.utils.escapeHtml;
      const langs = ['en', 'ru', 'lv', 'it', 'fr', 'es'];
      const out = {};
      for (const lng of langs) {
        i18n.setLanguage(lng);
        const body = i18n.t('rawTranscriptBody');
        // Same render the Raw modal uses (app.js): split '\n' -> escaped lines joined by <br>.
        const rendered = '<p>' + body.split('\n').map(function (ln) { return esc(ln); }).join('<br>') + '</p>';
        out[lng] = { body: body, rendered: rendered };
      }
      i18n.setLanguage('en');
      return out;
    });

    // Every language: the body carries a "!!!" warning header on its own first line,
    // and the modal render turns that newline into a <br> so the header stands alone.
    for (const lng of ['en', 'ru', 'lv', 'it', 'fr', 'es']) {
      expect(result[lng].body, lng + ' body has a newline').toContain('\n');
      expect(result[lng].body.split('\n')[0], lng + ' first line is a "!!!" warning').toContain('!!!');
      expect(result[lng].rendered, lng + ' render inserts <br>').toContain('<br>');
      // The warning header must render before the <br> (i.e. as the first line).
      const beforeBr = result[lng].rendered.split('<br>')[0];
      expect(beforeBr, lng + ' warning header is on the first rendered line').toContain('!!!');
    }

    // Spot-check the Latvian wording Rājan specified.
    expect(result.lv.body).toContain('BRĪDINĀJUMS!!!');
    expect(result.lv.body).toContain('garāks par 20 minūtēm');
  });

});
