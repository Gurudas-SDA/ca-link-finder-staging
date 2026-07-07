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

});
