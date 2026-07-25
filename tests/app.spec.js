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

// Helper: switch into the "quotes" view (In Text sentence search / By Verse /
// Verses (Top) — these controls only exist there, hidden via CSS in the
// "lectures" view the outer beforeEach starts every test in). MUST be called
// AFTER waitForAppReady(): the onboarding gate's "quotes" purpose defaults the
// search mode to "sentences", whose placeholder never contains a digit, so
// presetting ppp_purpose='quotes' before goto (via addInitScript) makes
// waitForAppReady's own readiness check hang forever. Clicking the utility
// row's view-switch button (the app's own real toggle — see
// PPP.app.switchView in js/app.js) after the app is ready sidesteps that.
async function useQuotesView(page) {
  await page.click('#viewSwitchBtn');
}

// Helper: open the compact language chooser (utility row "EN"/"RU"/... button)
// and pick a language. The full 6-button switcher (.lang-btn) is hidden by
// CSS once a purpose is chosen (body.purpose-set .language-switcher {
// display: none }) — it now only reveals itself as a dropdown under the
// compact button (see PPP.app.toggleLangChooser, js/app.js). Tests that used
// to click .lang-btn directly must open the dropdown first.
async function switchLanguage(page, lang) {
  // #langCompactBtn TOGGLES the dropdown — only click it if the dropdown is
  // currently closed, so two switchLanguage() calls in the same test (e.g.
  // ru then back to en) don't have the second call's click close what the
  // first call left open.
  const isOpen = await page.evaluate(() => {
    const el = document.getElementById('langSwitcherFull');
    return !!el && el.classList.contains('open');
  });
  if (!isOpen) await page.click('#langCompactBtn');
  await page.click(`.lang-btn[data-lang="${lang}"]`);
}

// Offline PWA startup: on a fresh profile the app shows a download-confirmation
// button before installing the full offline library into IndexedDB. The
// ppp_auto_install=1 localStorage hook (see app.js startFirstInstallFlow) skips
// only the button click and runs the REAL install flow — every test below
// therefore exercises the genuine offline startup path against the local
// static server before the app becomes ready.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('ppp_auto_install', '1');
      // Skip the onboarding gate (language + purpose picker) — land straight
      // in the "lectures" view, the UI surface this whole suite targets.
      localStorage.setItem('preferredLanguage', 'en');
      localStorage.setItem('ppp_purpose', 'lectures');
    } catch (e) {}
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

    // Click Quotes (all) button (By Verse — quotes-view only)
    await useQuotesView(page);
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

    // Click Top 108 button (Verses (Top) — quotes-view only)
    await useQuotesView(page);
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
    await switchLanguage(page, 'ru');

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

    // Verses (all)/(Top) live in the quotes view — switch there first.
    await useQuotesView(page);
    await page.locator('.search-mode-btn[data-mode="citations"]').click();
    await page.waitForTimeout(2000);

    await page.locator('.search-mode-btn[data-mode="citationsTop"]').click();
    await page.waitForTimeout(2000);

    // Back to the lectures view for "In Titles" (metadata) — useQuotesView
    // toggles switchView(), so calling it again from quotes flips back.
    await useQuotesView(page);
    await page.locator('.search-mode-btn[data-mode="metadata"]').click();
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
    for (const needle of ['Filters', 'By Added', 'Top Searches', 'By Verse', 'Verses (Top)', 'Favorites']) {
      expect(joined).toContain(needle);
    }

    const flexWrap = await page.locator('.search-quick-buttons.main-button-row').evaluate(el => getComputedStyle(el).flexWrap);
    expect(flexWrap).toBe('nowrap');
  });

  test('15. Filters button exists and is clickable', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('./');
    await waitForAppReady(page);

    const btn = page.locator('.search-quick-buttons.main-button-row .combo-btn', { hasText: 'Filters' });
    await expect(btn).toBeVisible();
    await btn.click();
    await page.waitForTimeout(500);
    await expect(page.locator('#filtersPanel')).toBeVisible();

    const critical = errors.filter(e =>
      !e.includes('favicon') && !e.includes('umami') && !e.includes('service-worker')
    );
    expect(critical).toHaveLength(0);

    const isFn = await page.evaluate(() => typeof window.PPP?.app?.toggleFilters === 'function');
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
    await switchLanguage(page, 'ru');
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('ru');

    await switchLanguage(page, 'en');
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

    // Switch to the sentence-search mode ("In Text" — quotes-view only).
    await useQuotesView(page);

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
    // word start). Unified layout: the sentence renders as a .sentence-hit
    // line under the file title inside the "File title / Sentence" column.
    const sentences = await page.locator('#resultsTable tbody tr .match-hint.sentence-hit').allTextContents();
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

  test('31b2. buildTranscriptSQL matches a multi-word term as ONE phrase, like the lecture-name search', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    const out = await page.evaluate(() => {
      const s = window.PPP.search;
      const nonLimit = (q) => Object.keys(q.params)
        .filter((k) => k !== '$limit').map((k) => q.params[k]);
      return {
        phrase: nonLimit(s.buildTranscriptSQL(s.parseSearchQuery('guru tattva'))),
        hyphen: nonLimit(s.buildTranscriptSQL(s.parseSearchQuery('guru-tattva'))),
        and: nonLimit(s.buildTranscriptSQL(s.parseSearchQuery('guru; tattva'))),
        or: nonLimit(s.buildTranscriptSQL(s.parseSearchQuery('guru tattva // nama tattva'))),
        // The lecture-name search has always treated a term as one substring;
        // "In Text" must not disagree with it.
        titles: Object.keys(s.buildMetaSQL(s.parseSearchQuery('guru tattva')).params)
          .map((k) => s.buildMetaSQL(s.parseSearchQuery('guru tattva')).params[k]),
      };
    });

    // ONE param, both words contiguous — not two ANDed word patterns.
    expect(out.phrase).toEqual(['% guru tattva%']);
    // Punctuation inside the term collapses to the same phrase (sentence_search
    // stores "guru-tattva" as "guru tattva").
    expect(out.hyphen).toEqual(['% guru tattva%']);
    // `;` still means AND across separate terms, `//` still means OR.
    expect(out.and).toEqual(['% guru%', '% tattva%']);
    expect(out.or).toEqual(['% guru tattva%', '% nama tattva%']);
    // Titles mode already phrase-matched; the two modes now agree.
    expect(out.titles).toEqual(['%guru tattva%']);
  });

  // ===== Filters panel (Years + Countries) — replaces the old "By 2026" =====

  test('50a. normalizeCountry folds drifted codes to one canonical, hides junk, keeps Online', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    const out = await page.evaluate(() => {
      const c = window.PPP.config;
      const n = (x) => c.normalizeCountry(x);
      return {
        // canonical passes through
        lva: n('LVA, Riga'), rus: n('RUS, Moscow'), online: n('Online'),
        // drifted variants fold to one code
        lat: n('LAT'), nlz: n('NLZ'), lit: n('LIT'), mexico: n('MEXICO'),
        // missing comma / stray punctuation still yields the code
        fraDijon: n('FRA Dijon'), indSemi: n('IND;'),
        // junk is hidden (null)
        unknown: n('unknown'), empty: n(''), none: n('none'), interviews: n('Interviews'),
        bogus: n('ZZZ'),
        // the reverse map used by the country filter
        lvaMatches: c.countryMatchCodes('LVA').sort(),
        // localized name
        nameLv: c.countryName('DEU', 'lv'), nameRu: c.countryName('USA', 'ru'),
      };
    });

    expect(out.lva).toBe('LVA');
    expect(out.rus).toBe('RUS');
    expect(out.online).toBe('Online');
    expect(out.lat).toBe('LVA');
    expect(out.nlz).toBe('NZL');
    expect(out.lit).toBe('LTU');
    expect(out.mexico).toBe('MEX');
    expect(out.fraDijon).toBe('FRA');
    expect(out.indSemi).toBe('IND');
    expect(out.unknown).toBeNull();
    expect(out.empty).toBeNull();
    expect(out.none).toBeNull();
    expect(out.interviews).toBeNull();
    expect(out.bogus).toBeNull();      // unmapped code is treated as junk
    expect(out.lvaMatches).toEqual(['lat', 'lva']);
    expect(out.nameLv).toBe('Vācija');
    expect(out.nameRu).toBe('США');
  });

  test('50b. year:/country: filters parse and build the expected metadata SQL', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    const out = await page.evaluate(() => {
      const s = window.PPP.search;
      const parsed = s.parseSearchQuery('year:2024,2025; country:LVA,RUS');
      const built = s.buildMetaSQL(parsed);
      return {
        years: parsed.filters.year,
        countries: parsed.filters.country,
        sql: built.sql,
        params: built.params,
        // a bad year is dropped; a lone country still parses
        badYear: s.parseSearchQuery('year:20xx,2020').filters.year,
      };
    });

    expect(out.years).toEqual(['2024', '2025']);
    expect(out.countries).toEqual(['LVA', 'RUS']);
    expect(out.badYear).toEqual(['2020']);

    // Years → date LIKE 'YYYY%', ORed together.
    const yearParams = Object.keys(out.params).filter((k) => k.startsWith('$yr')).map((k) => out.params[k]);
    expect(yearParams.sort()).toEqual(['2024%', '2025%']);
    expect(out.sql).toContain('l.date LIKE');

    // LVA expands to its drifted variant "lat" too; RUS has no variant.
    const codeParams = Object.keys(out.params).filter((k) => k.startsWith('$ccode')).map((k) => out.params[k]);
    expect(codeParams.sort()).toEqual(['lat', 'lva', 'rus']);
    expect(out.sql).toContain('l.country_norm');
  });

  test('50b2. In Text: buildTranscriptSQL ANDs a year onto the phrase, and the count query joins lectures only then', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    const out = await page.evaluate(() => {
      const s = window.PPP.search;
      const withYear = s.buildTranscriptSQL(s.parseSearchQuery('guru tattva; year:2025'));
      const noYear = s.buildTranscriptSQL(s.parseSearchQuery('guru tattva'));
      const yearOnly = s.buildTranscriptSQL(s.parseSearchQuery('year:2025'));
      return {
        withYearParams: Object.keys(withYear.params).filter(k => k !== '$limit').map(k => withYear.params[k]),
        withYearSql: withYear.sql,
        withYearCount: withYear.countSql,
        noYearCount: noYear.countSql,
        yearOnly: yearOnly,   // null — a year alone is not a text search
      };
    });

    // Phrase param + year param, both present.
    expect(out.withYearParams).toContain('% guru tattva%');
    expect(out.withYearParams).toContain('2025%');
    expect(out.withYearSql).toContain('l.date LIKE');
    // Count joins lectures ONLY when a year is filtered (perf: no JOIN otherwise).
    expect(out.withYearCount).toContain('LEFT JOIN lectures');
    expect(out.noYearCount).not.toContain('JOIN lectures');
    // Year with no text term is not a transcript-text search.
    expect(out.yearOnly).toBeNull();
  });

  test('50c. Filters button opens a panel; Apply writes tokens into the search field and filters results', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // The old "By 2026" is gone; the button is now "Filters".
    const btn = page.locator('.main-button-row .combo-btn-1');
    await expect(btn).toHaveText(/Filters/);

    // Opens the panel with year + country checkboxes.
    await btn.click();
    const panel = page.locator('#filtersPanel');
    await expect(panel).toBeVisible();
    expect(await panel.locator('.flt-year').count()).toBeGreaterThan(5);
    expect(await panel.locator('.flt-country').count()).toBeGreaterThan(5);

    // Country rows are "CODE (Localized name)" and sorted by 3-letter code.
    const codes = await panel.locator('.flt-country').evaluateAll(
      els => els.map(e => e.value));
    const sorted = [...codes].sort();
    expect(codes).toEqual(sorted);
    await expect(panel.locator('.flt-country[value="LVA"]').locator('xpath=..'))
      .toContainText('LVA (');

    // Pick 2025 + LVA, Apply.
    await panel.locator('.flt-year[value="2025"]').check();
    await panel.locator('.flt-country[value="LVA"]').check();
    await panel.locator('.flt-apply').click();

    // Selected filters appear in the search field as readable tokens.
    const val = await page.locator('#searchTerm').inputValue();
    expect(val).toContain('year:2025');
    expect(val).toContain('country:LVA');

    // Results are actually filtered: every visible Country cell is Latvia
    // (code LVA or its drifted variant LAT), and every Date is 2025.
    await page.waitForSelector('#resultsInfo strong', { timeout: 15000 });
    const rows = await page.locator('#resultsTable tbody tr').count();
    expect(rows).toBeGreaterThan(0);
  });

  test('50e. In Text mode: Filters panel hides Countries and keeps the typed word, adding only the year', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    await useQuotesView(page);
    await page.fill('#searchTerm', 'krishna');

    await page.locator('.main-button-row .combo-btn-1').click();
    const panel = page.locator('#filtersPanel');
    await expect(panel).toBeVisible();
    expect(await panel.locator('.flt-year').count()).toBeGreaterThan(5);
    expect(await panel.locator('.flt-country').count()).toBe(0);   // no country in sentence DB

    await panel.locator('.flt-year[value="2025"]').check();
    await panel.locator('.flt-apply').click();

    const val = await page.locator('#searchTerm').inputValue();
    expect(val).toContain('krishna');       // typed word preserved
    expect(val).toContain('year:2025');
    expect(val).not.toContain('country:');
  });

  test('50d. Filters state does not survive a reload (panel opens empty every time)', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);
    await page.locator('.main-button-row .combo-btn-1').click();
    await page.locator('#filtersPanel .flt-year').first().check();
    await page.locator('#filtersPanel .flt-apply').click();

    await page.reload();
    await waitForAppReady(page);
    await page.locator('.main-button-row .combo-btn-1').click();
    const anyChecked = await page.locator('#filtersPanel input:checked').count();
    expect(anyChecked).toBe(0);
    expect(await page.locator('#searchTerm').inputValue()).toBe('');
  });

  test('31f. Phase B chunked sentence search — 21 shards, premium+raw, sorted, progress fired', async ({ page }) => {
    // The chunked engine fetches 21 gz shards over the network (one resident
    // at a time) — allow generous time on a cold static server.
    test.setTimeout(180000);

    await page.goto('./');
    await waitForAppReady(page);

    const out = await page.evaluate(async () => {
      const db = window.PPP.db;
      const search = window.PPP.search;
      // "guru" is confirmed to yield BOTH premium and raw hits inside the
      // merged top-500 (premium transcripts skew recent, raw fills the rest).
      const parsed = search.parseSearchQuery('guru');
      const q = search.buildTranscriptSQL(parsed);

      const progress = [];
      const res = await db.searchSentencesChunked(q.sql, q.countSql, q.params,
        function (done, total) { progress.push([done, total]); });

      const tiers = {};
      res.rows.forEach(function (r) { tiers[r.tier] = (tiers[r.tier] || 0) + 1; });

      // Verify the merged rows honor the SQL ORDER BY:
      //   knowns-before-unknowns, date DESC, nr ASC, seq ASC.
      let sortedOK = true;
      for (let i = 1; i < res.rows.length; i++) {
        const a = res.rows[i - 1], b = res.rows[i];
        const au = (!a.date || a.date === 'unknown') ? 1 : 0;
        const bu = (!b.date || b.date === 'unknown') ? 1 : 0;
        let cmp = au - bu;
        if (cmp === 0 && au === 0) {
          cmp = (a.date < b.date) ? 1 : (a.date > b.date ? -1 : 0);
        }
        if (cmp === 0) cmp = (a.nr || 0) - (b.nr || 0);
        if (cmp === 0) cmp = (a.seq || 0) - (b.seq || 0);
        if (cmp > 0) { sortedOK = false; break; }
      }

      return {
        rowCount: res.rows.length,
        totalCount: res.count,
        lectures: res.lectures,
        tiers: tiers,
        progressLen: progress.length,
        lastProgress: progress[progress.length - 1],
        sortedOK: sortedOK,
        hasTsEnd: res.rows.length > 0 && ('ts_end' in res.rows[0]),
        hasTs: res.rows.length > 0 && ('ts' in res.rows[0])
      };
    });

    // Progress callback fired once per shard, for all 21 shards.
    expect(out.progressLen).toBe(21);
    expect(out.lastProgress).toEqual([21, 21]);

    // Merged result is capped to the 500 default limit.
    expect(out.rowCount).toBe(500);
    // Total count is summed across shards and far exceeds the 500-row page.
    expect(out.totalCount).toBeGreaterThan(500);
    expect(out.lectures).toBeGreaterThan(0);

    // BOTH tiers present in the merged top-500 — proves the search now covers
    // premium AND raw (raw = lecture whose meta Script_EN=='Raw').
    expect(out.tiers.premium).toBeGreaterThan(0);
    expect(out.tiers.raw).toBeGreaterThan(0);

    // Merge re-applies the ORDER BY correctly across shard boundaries.
    expect(out.sortedOK).toBe(true);

    // Row shape carries ts and the newly-selected ts_end (not rendered yet).
    expect(out.hasTs).toBe(true);
    expect(out.hasTsEnd).toBe(true);
  });

  test('31c. "In Text" mode shows a dedicated search placeholder', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // The install banner (if it ever appears) overlaps the mode buttons — hide it.
    await page.evaluate(() => {
      const b = document.getElementById('installBanner');
      if (b) b.style.display = 'none';
    });

    await useQuotesView(page);

    const placeholder = await page.locator('#searchTerm').getAttribute('placeholder');
    expect(placeholder).toContain('Search in transcript sentences');
    expect(placeholder).not.toContain('audio recording titles');
  });

  test('31d. "In Text" mode swaps the results header frame immediately, reverts on "In Titles"', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    await page.evaluate(() => {
      const b = document.getElementById('installBanner');
      if (b) b.style.display = 'none';
    });

    // Pressing the mode button — with NO search run yet — must immediately
    // swap the results table into the sentence-mode frame: distinct class
    // (drives the different header tone in CSS) + localized column headers.
    await useQuotesView(page);

    const table = page.locator('#resultsTable');
    await expect(table).toHaveClass(/sentence-mode/);
    await expect(table).not.toHaveClass(/lecture-cards/);
    // Unified header: localized "File title / Sentence" column present (EN).
    await expect(table.locator('thead')).toContainText('File title / Sentence');
    // Active "In Text" button carries the sentence-mode olive identity
    // (same tones as the sentence table header) in light mode.
    const activeBg = await page.locator('.text-search-btn.active').evaluate(
      (el) => getComputedStyle(el).backgroundImage || getComputedStyle(el).background
    );
    expect(activeBg).toContain('rgb(91, 107, 63)');
    // Empty-state hint text, not the generic "enter search terms" message.
    await expect(page.locator('#resultsTable tbody')).toContainText('Type a word and press Search');

    // Switching back to "In Titles" restores the normal lecture-table frame
    // (useQuotesView toggles switchView(), so calling it again flips back to
    // lectures, where "In Titles"/metadata mode is the default).
    await useQuotesView(page);
    await expect(table).not.toHaveClass(/sentence-mode/);
    await expect(table).toHaveClass(/lecture-cards/);
  });

  test('31e. Placeholder race: switching to "In Text" survives a later async placeholder refresh', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    await page.evaluate(() => {
      const b = document.getElementById('installBanner');
      if (b) b.style.display = 'none';
    });

    await useQuotesView(page);
    await expect(page.locator('#searchTerm')).toHaveAttribute('placeholder', /Search in transcript sentences/);

    // Re-run the language-switch code path (same code path that used to
    // unconditionally reassign the placeholder to the metadata {count} text
    // any time the meta DB finished loading or the language changed, even
    // if the user had already switched to a different mode — the exact race
    // Rājan hit in production). The centralized updateSearchModePlaceholder()
    // must keep the placeholder correct for the mode actually active now.
    await page.evaluate(() => {
      const lang = (window.PPP.i18n.getLanguage && window.PPP.i18n.getLanguage()) || 'en';
      PPP.app.setLanguage(lang);
    });

    const placeholder = await page.locator('#searchTerm').getAttribute('placeholder');
    expect(placeholder).toContain('Search in transcript sentences');
    expect(placeholder).not.toContain('audio recording titles');
  });

  test('35. Sentence search checkboxes drive the shared "Download selected" button', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto('./');
    await waitForAppReady(page);
    await page.evaluate(() => {
      const b = document.getElementById('installBanner');
      if (b) b.style.display = 'none';
    });

    await useQuotesView(page);
    await page.fill('#searchTerm', 'rice');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#resultsInfo strong', { timeout: 90000 });

    // Unified layout: EN transcript checkboxes render in the Script_EN
    // column of every result row — the SAME .select-checkbox /
    // _renderScriptChip mechanism as the metadata table (LV/RU/mp3
    // checkboxes may also be present, so filter by data-lang).
    const boxes = page.locator('#resultsTable tbody tr input.select-checkbox[data-lang="en"]');
    const n = await boxes.count();
    expect(n).toBeGreaterThan(0);

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

    await useQuotesView(page);
    await page.fill('#searchTerm', 'rice');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#resultsInfo strong', { timeout: 90000 });

    const boxes = page.locator('#resultsTable tbody tr input.select-checkbox[data-lang="en"]');
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

  test('36b. Sentence table: no standalone Time column; matched sentence shows inline start-only "(ts)"; no Length/Quality; LV/RU chips in rows', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto('./');
    await waitForAppReady(page);
    await page.evaluate(() => {
      const b = document.getElementById('installBanner');
      if (b) b.style.display = 'none';
    });

    await useQuotesView(page);

    // Main header row (2nd thead row — the 1st is the transparent spacer):
    // star, share, Date, Type, File title / Sentence, Country, Lang.,
    // Links, Dwnld., Transcripts&Translations block. Rājan correction #3:
    // the standalone Time/Timestamp column was REMOVED — the matched
    // sentence's start time renders inline as "Name (ts)" instead.
    const headers = await page.locator('#resultsTable thead tr:nth-child(2) th').allTextContents();
    expect(headers).not.toContain('Time');
    expect(headers).not.toContain('Timestamp');
    expect(headers).toContain('File title / Sentence');
    expect(headers).toContain('Date');
    expect(headers).toContain('Dwnld.');
    expect(headers).not.toContain('Length');
    expect(headers).not.toContain('Quality');
    // EN/LV/RU transcript sub-header row present (same block as In Titles).
    await expect(page.locator('#resultsTable thead .transcript-lang')).toHaveText(['EN', 'LV', 'RU']);

    // With results: rows are full metadata rows — LV/RU chips render whenever
    // the lecture actually has those transcripts (same rule as In Titles).
    // Pre-load extras so the essence data IS available when rows render —
    // making the "no essence in sentence rows" assertion below meaningful
    // (essence would otherwise be absent merely because extras lag).
    await page.evaluate(() => PPP.ui.loadExtras());
    await page.waitForFunction(() => PPP.ui.extrasReady(), { timeout: 30000 });
    await page.fill('#searchTerm', 'rice');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#resultsInfo strong', { timeout: 90000 });

    // Sentence line renders under the title.
    expect(await page.locator('#resultsTable tbody .match-hint.sentence-hit').count()).toBeGreaterThan(0);

    // Rājan corrections #3+#4: the matched sentence shows an inline START-only
    // timestamp "(ts)" appended to its name — verify the .sentence-ts span
    // renders, is parenthesised, and is NOT the cancelled range (start–end) form.
    const tsSpans = page.locator('#resultsTable tbody .sentence-ts');
    expect(await tsSpans.count()).toBeGreaterThan(0);
    const tsText = (await tsSpans.first().textContent()).trim();
    expect(tsText).toMatch(/^\(\d{1,2}:\d{2}(?::\d{2})?\)$/);
    expect(tsText).not.toContain('–'); // en-dash range form was cancelled

    // Rājan rule: sentence-hit rows show ONLY title + sentence — NO essence
    // line and NO translated-title hint (those belong to "In Titles" mode).
    expect(await page.locator('#resultsTable tbody .essence-hint').count()).toBe(0);
    expect(await page.locator('#resultsTable tbody .translated-title').count()).toBe(0);

    // Cross-check chip presence against the metadata DB for the first row.
    const chipCheck = await page.evaluate(() => {
      const tr = document.querySelector('#resultsTable tbody tr');
      const enBox = tr.querySelector('input.select-checkbox[data-lang="en"]');
      const nr = enBox ? enBox.getAttribute('data-nr') : null;
      const meta = nr && PPP.app.getDbRowByNr ? PPP.app.getDbRowByNr(nr) : null;
      const avail = (v) => {
        v = (v || '').toString().trim();
        return v && v !== 'N/A' && v !== '0' &&
          !['Not relevant', 'Neattiecas', 'Не относится'].includes(v);
      };
      return {
        hasEnBox: !!enBox,
        metaFound: !!meta,
        lvExpected: meta ? avail(meta['Script_LV']) : null,
        lvRendered: !!tr.querySelector('.script-chip[data-lang="lv"]'),
        ruExpected: meta ? avail(meta['Script_RU']) : null,
        ruRendered: !!tr.querySelector('.script-chip[data-lang="ru"]'),
      };
    });
    expect(chipCheck.hasEnBox).toBe(true);
    expect(chipCheck.metaFound).toBe(true);
    // Duplicates also render a (non-selectable) chip, so rendered may exceed
    // expected-available; but an AVAILABLE transcript must always render.
    if (chipCheck.lvExpected) expect(chipCheck.lvRendered).toBe(true);
    if (chipCheck.ruExpected) expect(chipCheck.ruRendered).toBe(true);
  });

  test('36c. Checking an MP3 checkbox (sentence table Dwnld. column) increases the "Download selected" count', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto('./');
    await waitForAppReady(page);
    await page.evaluate(() => {
      const b = document.getElementById('installBanner');
      if (b) b.style.display = 'none';
    });

    await useQuotesView(page);
    await page.fill('#searchTerm', 'rice');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#resultsInfo strong', { timeout: 90000 });

    const mp3Boxes = page.locator('#resultsTable tbody tr input.select-checkbox[data-lang="mp3"]');
    const n = await mp3Boxes.count();
    test.skip(n === 0, 'No MP3-linked lecture in this result page — cannot exercise MP3 checkbox');

    const dlBtn = page.locator('#downloadSelectedBtn');
    await expect(dlBtn).toBeDisabled();

    await mp3Boxes.nth(0).check();
    await expect(dlBtn).toBeEnabled();
    await expect(dlBtn).toContainText('(1)');

    // Panel headline, MP3-only selection: "{a} MP3 ({m} lectures)" — MP3
    // picks must NOT be labeled as transcripts (Rājan fix).
    await dlBtn.click();
    const selCount = page.locator('#selectCount');
    await expect(selCount).toHaveText('1 MP3 (1 lectures)');

    // Add an EN transcript pick for the SAME lecture -> mixed form:
    // "1 transcripts + 1 MP3 (1 lectures)". (Sentence rows are EN hits, so
    // the lecture behind the MP3 box always has an EN chip checkbox too.)
    const mp3Nr = await mp3Boxes.nth(0).getAttribute('data-nr');
    const sameLectureEn = page.locator(
      `#resultsTable tbody input.select-checkbox[data-lang="en"][data-nr="${mp3Nr}"]`
    ).first();
    await sameLectureEn.check();
    await expect(dlBtn).toContainText('(2)');
    await expect(selCount).toHaveText('1 transcripts + 1 MP3 (1 lectures)');

    // Untick the MP3 -> pure-transcript form (existing nSelectedPairs text).
    await mp3Boxes.nth(0).uncheck();
    await expect(selCount).toHaveText('1 transcripts (1 lectures)');
  });

  test('36d. Language switch in "In Text" mode keeps the sentence results, localizes the headers', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto('./');
    await waitForAppReady(page);
    await page.evaluate(() => {
      const b = document.getElementById('installBanner');
      if (b) b.style.display = 'none';
    });

    await useQuotesView(page);
    await page.fill('#searchTerm', 'rice');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#resultsInfo strong', { timeout: 90000 });

    const rowsBefore = await page.locator('#resultsTable tbody tr').count();
    expect(rowsBefore).toBeGreaterThan(0);

    // Switch UI language to Russian — results must SURVIVE (bug: they used
    // to be wiped by the generic metadata empty-table render in setLanguage),
    // and headers/summary must re-render in the new language.
    await switchLanguage(page, 'ru');

    const rowsAfter = await page.locator('#resultsTable tbody tr').count();
    expect(rowsAfter).toBe(rowsBefore);
    // Unified header now in Russian (sentColFileSentence).
    await expect(page.locator('#resultsTable thead')).toContainText('Название файла / Предложение');
    // Summary line is re-rendered localized too (RU sentenceResultsSummary).
    await expect(page.locator('#resultsInfo strong')).toContainText('Найдено');

    // Switch back to EN: results still present, header English again.
    await switchLanguage(page, 'en');
    expect(await page.locator('#resultsTable tbody tr').count()).toBe(rowsBefore);
    await expect(page.locator('#resultsTable thead')).toContainText('File title / Sentence');
  });

  test('36e. MP3 ZIP count cap: 6th MP3 checkbox is refused (stays unchecked) with a toast; download button still counts 5', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // Drive toggleSelectPair directly (same function the real MP3 checkbox
    // onchange handler calls) — deterministic, no dependency on which
    // lectures happen to have MP3 links in the currently rendered page.
    const result = await page.evaluate(() => {
      // Start from a clean selection.
      PPP.app.clearSelection();
      const applied = [];
      for (let i = 1; i <= 6; i++) {
        applied.push(PPP.app.toggleSelectPair(String(i), 'mp3', true));
      }
      const btn = document.getElementById('downloadSelectedBtn');
      const toastEl = document.getElementById('uiToast');
      const out = {
        applied,
        maxCount: PPP.app._getMp3ZipMaxCount ? PPP.app._getMp3ZipMaxCount() : null,
        btnText: btn ? btn.textContent : null,
        toastText: toastEl ? toastEl.textContent : null,
        toastShown: toastEl ? toastEl.classList.contains('show') : false
      };
      PPP.app.clearSelection();
      return out;
    });

    expect(result.maxCount).toBe(5);
    // First 5 MP3s are accepted, the 6th is refused (returns false).
    expect(result.applied).toEqual([true, true, true, true, true, false]);
    // Download button reflects exactly 5 selected, not 6.
    expect(result.btnText).toContain('(5)');
    // Toast fired with the mp3ZipMaxCount message (interpolated {max}=5).
    expect(result.toastShown).toBe(true);
    expect(result.toastText).toContain('5');

    // Same message is reachable via i18n directly and mentions MP3.
    const msg = await page.evaluate(() => PPP.i18n.t('mp3ZipMaxCount').replace('{max}', 5));
    expect(msg).toContain('5');
    expect(msg.toLowerCase()).toContain('mp3');
  });

  test('36e2. Checking a real MP3 checkbox in the results table beyond the cap is also refused (checkbox snaps back unchecked)', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto('./');
    await waitForAppReady(page);
    await page.evaluate(() => {
      const b = document.getElementById('installBanner');
      if (b) b.style.display = 'none';
    });

    await useQuotesView(page);
    await page.fill('#searchTerm', 'rice');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#resultsInfo strong', { timeout: 90000 });

    const mp3Boxes = page.locator('#resultsTable tbody tr input.select-checkbox[data-lang="mp3"]');
    const n = await mp3Boxes.count();
    test.skip(n === 0, 'No MP3-linked lecture in this result page — cannot exercise MP3 checkbox');

    // Pre-fill the selection with 5 synthetic MP3 picks (not tied to any
    // visible row) so checking ONE real checkbox in the DOM is the 6th —
    // this keeps the test deterministic regardless of how many MP3-linked
    // rows the current result page happens to contain.
    await page.evaluate(() => {
      PPP.app.clearSelection();
      for (let i = 1001; i <= 1005; i++) PPP.app.toggleSelectPair(String(i), 'mp3', true);
    });

    const box = mp3Boxes.nth(0);
    // NOTE: Playwright's .check() asserts the box ENDS UP checked, which is
    // exactly what this test disproves — use a plain .click() instead.
    await box.click();
    // Refused: the browser checkbox snaps back to unchecked.
    await expect(box).not.toBeChecked();
    await expect(page.locator('#uiToast')).toHaveClass(/show/);
    await expect(page.locator('#uiToast')).toContainText('5');

    await page.evaluate(() => PPP.app.clearSelection());
  });

  test('36f. Sentence-search busy lock: mode switch / new search / language change are refused while a search is in flight, and work again after it finishes', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto('./');
    await waitForAppReady(page);
    await page.evaluate(() => {
      const b = document.getElementById('installBanner');
      if (b) b.style.display = 'none';
    });

    // Warm the sentences DB with a first real search so the DB load is not the
    // variable here — the race we exercise is the query continuation, not the
    // one-time DB download.
    await useQuotesView(page);
    await page.fill('#searchTerm', 'rice');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#resultsInfo strong', { timeout: 90000 });
    expect(await page.locator('#resultsTable tbody .match-hint.sentence-hit').count()).toBeGreaterThan(0);

    // Kick off a NEW sentence search, then IMMEDIATELY (same tick, before the
    // async DB query resolves) try to switch mode, start another search, and
    // change language. All three must be refused with the searchInProgress
    // toast, and the in-flight search's own state must still be intact.
    const attempt = await page.evaluate(() => {
      document.getElementById('searchTerm').value = 'krishna';
      PPP.app.search();               // kicks off performSentenceSearch (async), sets the busy lock
      const busyDuringSearch = PPP.app._isSentenceSearchBusyForTest ? PPP.app._isSentenceSearchBusyForTest() : null;
      const modeBefore = document.querySelector('.search-mode-btn.active').getAttribute('data-mode');
      PPP.app.setSearchMode('metadata');   // must be refused
      const modeAfterAttempt = document.querySelector('.search-mode-btn.active').getAttribute('data-mode');
      PPP.app.search();                    // must be refused (no-op)
      PPP.app.setLanguage('lv');           // must be refused
      const langAfterAttempt = document.documentElement.lang;
      return { busyDuringSearch, modeBefore, modeAfterAttempt, langAfterAttempt };
    });

    expect(attempt.busyDuringSearch).toBe(true);
    // Mode switch was refused — still in sentences mode.
    expect(attempt.modeBefore).toBe('sentences');
    expect(attempt.modeAfterAttempt).toBe('sentences');
    // Language switch was refused — still English (default test language).
    expect(attempt.langAfterAttempt).toBe('en');
    // The searchInProgress toast is visible.
    await expect(page.locator('#uiToast')).toHaveClass(/show/);
    await expect(page.locator('#uiToast')).toContainText(/wait|previous/i);

    // Let the in-flight ("krishna") search finish — poll the busy lock instead
    // of a fixed sleep so this isn't flaky under slow CI machines.
    await page.waitForFunction(() => (
      window.PPP && PPP.app._isSentenceSearchBusyForTest && PPP.app._isSentenceSearchBusyForTest() === false
    ), { timeout: 30000 });

    const busyAfter = await page.evaluate(() => (
      PPP.app._isSentenceSearchBusyForTest ? PPP.app._isSentenceSearchBusyForTest() : null
    ));
    expect(busyAfter).toBe(false);

    // Now that the lock is released, mode switching works again.
    await page.evaluate(() => PPP.app.setSearchMode('metadata'));
    const table = page.locator('#resultsTable');
    await expect(table).not.toHaveClass(/sentence-mode/);
  });

  test('37. Excel export — Script_EN URL cell is a clickable hyperlink', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto('./');
    await waitForAppReady(page);
    await page.evaluate(() => {
      const b = document.getElementById('installBanner');
      if (b) b.style.display = 'none';
    });

    await useQuotesView(page);
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

  test('37b. utils.isSafeUrl rejects unsafe URL schemes', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    const result = await page.evaluate(() => {
      return {
        httpsOk: PPP.utils.isSafeUrl('https://drive.google.com/x'),
        javascriptBlocked: PPP.utils.isSafeUrl('javascript:alert(1)'),
        emptyBlocked: PPP.utils.isSafeUrl(''),
      };
    });

    expect(result.httpsOk).toBe(true);
    expect(result.javascriptBlocked).toBe(false);
    expect(result.emptyBlocked).toBe(false);
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

    // A searched word that ALSO appears OUTSIDE any matched sentence must NOT be
    // green — only occurrences inside a matched sentence are marked (Rājan,
    // 2026-07-25: scattered green words across the lecture were confusing).
    const scopedResult = await page.evaluate(() => {
      var container = document.createElement('div');
      container.innerHTML =
        '<p>The guru spoke first.</p>' +                    // "guru" OUTSIDE any match
        '<p>We heard the glories of guru tattva today.</p>' + // the matched sentence
        '<p>Later the guru left.</p>';                        // "guru" OUTSIDE again
      PPP.app._wrapMatchesInContainer(
        container,
        ['We heard the glories of guru tattva today.'],
        ['guru', 'tattva']
      );
      var sentenceMark = container.querySelector('mark.tr-sentence');
      var wordMarks = Array.prototype.map.call(container.querySelectorAll('mark.tr-word'), m => m.textContent);
      // Every green word must live inside the single yellow sentence.
      var allInside = Array.prototype.every.call(
        container.querySelectorAll('mark.tr-word'), m => sentenceMark && sentenceMark.contains(m));
      return { wordMarks: wordMarks, allInside: allInside };
    });

    // Exactly the two words inside the matched sentence — the two stray "guru"
    // occurrences outside it stay unmarked.
    expect(scopedResult.wordMarks.map(w => w.toLowerCase()).sort()).toEqual(['guru', 'tattva']);
    expect(scopedResult.allInside).toBe(true);
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

  test('39b. In Text on-screen: matched word carries .sent-word-hit; the sentence line is yellow, the word green', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // The highlighter now tags the matched word with a class (not an inline
    // amber colour) so the two-tier CSS can paint green-on-yellow.
    const markup = await page.evaluate(() =>
      PPP.ui.highlightSentencePrefix('glories of Guru Tattva', ['guru', 'tattva']));
    expect(markup).toContain('class="sent-word-hit"');
    expect(markup).not.toContain('#fce9b8');   // old single-tier amber is gone

    // Rendered colours: run a real In Text search and read computed styles of
    // the on-screen sentence line + the highlighted word inside it.
    await useQuotesView(page);
    await page.fill('#searchTerm', 'krishna');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#resultsTable tbody .match-hint.sentence-hit', { timeout: 20000 });

    const colours = await page.evaluate(() => {
      const line = document.querySelector('#resultsTable tbody .match-hint.sentence-hit');
      const word = line && line.querySelector('.sent-word-hit');
      const bg = (el) => el && getComputedStyle(el).backgroundColor;
      return { sentenceBg: bg(line), wordBg: word ? bg(word) : null };
    });
    // #fff3a0 => rgb(255,243,160); #b6f5c0 => rgb(182,245,192)
    expect(colours.sentenceBg).toBe('rgb(255, 243, 160)');
    expect(colours.wordBg).toBe('rgb(182, 245, 192)');
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
    await switchLanguage(page, 'en');

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

// ONLINE-FIRST UX: online must be the base experience — usable immediately,
// with the (~196 MB) offline library download offered as an OPTIONAL banner
// instead of a blocking "Required on first start" install. This describe
// block overrides the file-wide ppp_auto_install=1 hook (see top of file)
// so it exercises the REAL not-installed / no-auto-install startup path.
test.describe('Online-first UX (no forced install)', () => {

  test.beforeEach(async ({ page }) => {
    // The outer test.beforeEach (top of file) already set ppp_auto_install=1
    // via addInitScript; a later addInitScript call runs after it and wins,
    // so this removes the flag for tests in this block only.
    await page.addInitScript(() => {
      try { localStorage.removeItem('ppp_auto_install'); } catch (e) {}
    });
  });

  test('App is immediately usable online without waiting for offline install', async ({ page }) => {
    await page.goto('./');

    // The search field must NOT stay stuck on the "Loading… Required" state —
    // it becomes enabled once the online (network) SQLite DB is ready, without
    // any offline install having to complete first.
    await waitForAppReady(page);

    const input = page.locator('#searchTerm');
    await expect(input).toBeEnabled();
    const placeholder = await input.getAttribute('placeholder');
    expect(placeholder).not.toMatch(/Loading/i);
    expect(placeholder).not.toMatch(/Required/i);

    // A real search works online, without any offline library installed.
    await input.fill('krishna');
    await page.click('button.search-button');
    await page.waitForFunction(() => {
      const info = document.getElementById('resultsInfo');
      return info && info.textContent && info.textContent.trim().length > 0;
    }, { timeout: 30000 });
    const resultsText = await page.locator('#resultsInfo').textContent();
    expect(resultsText.trim().length).toBeGreaterThan(0);
  });

  test('Optional offline download button appears only after the online DB is ready, not as a banner', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);

    // App must already be fully usable once the small "Work offline" button
    // is (or becomes) visible.
    await expect(page.locator('#searchTerm')).toBeEnabled();

    // No big banner anywhere in the load flow — the offer is a small button
    // next to "How to use search?".
    await expect(page.locator('#offlineOffer')).toHaveCount(0);

    const workBtn = page.locator('#offlineWorkBtn');
    await expect(workBtn).toBeVisible({ timeout: 15000 });

    // Info panel + Download button only appear after a click.
    const infoPanel = page.locator('#offlineInfoPanel');
    await expect(infoPanel).toBeHidden();
    await workBtn.click();
    await expect(infoPanel).toBeVisible();
    const offerBtn = infoPanel.locator('#offlineOfferBtn');
    await expect(offerBtn).toBeVisible();

    // Neither the button nor the info panel intercept clicks elsewhere on
    // the page — the search button must still be clickable.
    await expect(page.locator('button.search-button').first()).toBeEnabled();

    // Clicking Download starts the background install; progress shows in
    // #offlineProgress, independent of the info panel.
    await offerBtn.click();
    const progress = page.locator('#offlineProgress');
    await expect(progress).toBeVisible({ timeout: 15000 });

    // Closing the info panel mid-download does NOT hide the progress row.
    await infoPanel.locator('button[aria-label="Close"]').click();
    await expect(infoPanel).toBeHidden();
    await expect(progress).toBeVisible();
  });

  test('42. Checkbox-sync: toggling one row syncs every row of the same lecture (sentence search)', async ({ page }) => {
    await page.goto('./');
    await waitForAppReady(page);
    await switchLanguage(page, 'en');

    // "In Text" (sentence) search returns MANY rows for the same lecture — one
    // per matching sentence. Each row renders its own per-language checkbox for
    // the SAME "<nr>|<lang>" selection pair, so every sibling checkbox must stay
    // visually in sync with the shared selection Set (ui.js _syncSelCheckboxes).
    await useQuotesView(page);
    await page.fill('#searchTerm', 'krishna');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.select-checkbox[data-lang="en"]', { timeout: 20000 });

    // Find a lecture nr that appears in at least two EN sibling checkboxes.
    const nr = await page.evaluate(() => {
      const cnt = {};
      document.querySelectorAll('.select-checkbox[data-lang="en"]').forEach(b => {
        const n = b.getAttribute('data-nr'); cnt[n] = (cnt[n] || 0) + 1;
      });
      const best = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
      return (best && cnt[best] > 1) ? best : null;
    });
    expect(nr).not.toBeNull(); // sentence search must produce sibling rows

    const sib = (lang) => `.select-checkbox[data-nr="${nr}"][data-lang="${lang}"]`;
    const enCount = await page.locator(sib('en')).count();
    expect(enCount).toBeGreaterThan(1);

    // Tick ONE sibling → every EN sibling of that lecture becomes checked.
    await page.locator(sib('en')).first().check();
    expect(await page.locator(sib('en') + ':checked').count()).toBe(enCount);

    // Independence: the SAME lecture's LV checkboxes must NOT be affected.
    expect(await page.locator(sib('lv') + ':checked').count()).toBe(0);

    // The selection is ONE lecture-language pair, not enCount of them — the
    // "Download selected" button shows (1), and the MP3 cap is unaffected.
    await expect(page.locator('#downloadSelectedBtn')).toContainText('(1)');

    // Unticking a DIFFERENT sibling clears every EN sibling of that lecture.
    await page.locator(sib('en')).last().uncheck();
    expect(await page.locator(sib('en') + ':checked').count()).toBe(0);
    await expect(page.locator('#downloadSelectedBtn')).toBeDisabled();
  });

  test('43. "In Text" search offline (shards not installed) shows a clean message, not a raw error', async ({ page }) => {
    test.setTimeout(60000);

    await page.goto('./');
    await waitForAppReady(page);

    // Switch to sentence-search ("In Text") mode while still online.
    await useQuotesView(page);

    // Go offline — the sentence shards are opt-in and not installed on this
    // profile, so the shard fetch has no network path and must reject.
    const context = page.context();
    await context.setOffline(true);

    await page.fill('#searchTerm', 'krishna');
    await page.keyboard.press('Enter');

    // The catch handler must render the graceful offline message, never the
    // raw "Error: ..." string surfaced for a real (online) failure.
    await expect(page.locator('#resultsInfo')).not.toContainText('Error:', { timeout: 20000 });
    await expect(page.locator('#resultsInfo')).toContainText(/offline|bezsaist|[оО]флайн/i, { timeout: 20000 });

    await context.setOffline(false);
  });

  // ---- Field-bug fixes (2026-07-24, Android reports) ----------------------

  test('44. Premium transcript opens when net.online lies "false" but the network works (fetch, not flag)', async ({ page }) => {
    // FIX 1: navigator.onLine (mirrored by PPP.net.online) can report "offline"
    // on some Android PWAs while a real connection exists. The viewer must
    // ALWAYS attempt the transcript fetch and decide by its actual outcome — a
    // working fetch renders, never the offline "not in library" modal.
    const MARK = 'NETLIVE_PREMIUM_BODY_9f3a';
    await page.route('**/transcripts/en/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<p>' + MARK + ' ' + 'lecture text '.repeat(20) + '</p>',
    }));

    await page.goto('./');
    await waitForAppReady(page);

    // A lecture nr that is NOT in the installed IDB library, so the ONLY way to
    // render it is the network fetch. Force the unreliable flag to "offline".
    await page.evaluate(() => { if (window.PPP && PPP.net) PPP.net.online = false; });
    await page.evaluate(() => PPP.app.openHtmlTranscriptViewer('9990001', 'en'));

    // The served body renders despite net.online === false — proof the fetch
    // was attempted rather than short-circuited on the flag.
    await expect(page.locator('#transcriptModalBody')).toContainText(MARK, { timeout: 15000 });
    // And none of the offline miss-modals fired.
    await expect(page.locator('#transcriptModalBody')).not.toContainText('not downloaded');
    await expect(page.locator('#transcriptModalTitle')).not.toContainText('Not in the offline library');
  });

  test('47. In Text: opening the transcript jumps to and highlights the matched sentence', async ({ page }) => {
    // The matched sentence is passed as the 6th arg of openHtmlTranscriptViewer;
    // it reuses the deep-link _highlightAndScroll path (mark.transcript-deep-
    // highlight). Serve a transcript body that contains the sentence so the
    // locate-and-scroll can find it deterministically.
    const SENTENCE = 'By hearing from a nama-tattva-vit-guru, one is purified.';
    // Lots of filler ABOVE the sentence so the target is genuinely below the
    // fold — proves the viewer scrolled, not merely that the mark exists.
    const fillerP = '<p>' + 'padding text that fills the modal viewport '.repeat(12) + '</p>';
    await page.route('**/transcripts/en/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: fillerP.repeat(60) + '<p>' + SENTENCE + '</p>' + fillerP.repeat(10),
    }));

    await page.goto('./');
    await waitForAppReady(page);

    // net flag forced offline to prove the fetch still happens (as in test 44);
    // 9990047 is not in IDB so the network body is the only source.
    await page.evaluate(() => { if (window.PPP && PPP.net) PPP.net.online = false; });
    await page.evaluate((s) => PPP.app.openHtmlTranscriptViewer('9990047', 'en', null, null, null, s), SENTENCE);

    // The matched sentence is wrapped in the yellow two-tier band (tr-sentence);
    // the green per-word marking inside it is the same _wrapMatchesInContainer
    // path unit-tested by test 38.
    const mark = page.locator('#transcriptModalBody mark.tr-sentence').first();
    await expect(mark).toBeVisible({ timeout: 15000 });
    await expect(mark).toContainText('By hearing from a nama');

    // It was actually scrolled into the modal's visible area (target sits far
    // below the fold in a 70-paragraph transcript). Give the +300ms scroll a
    // beat, then check the mark's box lies within the modal body's viewport.
    await page.waitForTimeout(500);
    const inView = await page.evaluate(() => {
      const body = document.getElementById('transcriptModalBody');
      const m = body.querySelector('mark.tr-sentence');
      const br = body.getBoundingClientRect(), mr = m.getBoundingClientRect();
      return mr.top >= br.top - 2 && mr.top <= br.bottom;   // inside the visible strip
    });
    expect(inView).toBe(true);
  });

  test('47b. In Text transcript: searched words inside the matched sentence are green (tr-word)', async ({ page }) => {
    const SENTENCE = 'By hearing from a nama-tattva-vit-guru one is purified.';
    await page.route('**/transcripts/en/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<p>' + 'filler '.repeat(30) + '</p><p>' + SENTENCE + '</p>',
    }));

    await page.goto('./');
    await waitForAppReady(page);

    // Seed the current In-Text search words (what a real search would set), then
    // deep-open the transcript at the sentence.
    await page.evaluate(() => PPP.app._setSentenceWordsForTest(['hearing', 'guru']));
    await page.evaluate(() => { if (window.PPP && PPP.net) PPP.net.online = false; });
    await page.evaluate((s) => PPP.app.openHtmlTranscriptViewer('9990048', 'en', null, null, null, s), SENTENCE);

    // Two-tier inside the transcript: yellow sentence band + green word marks.
    const sentence = page.locator('#transcriptModalBody mark.tr-sentence').first();
    await expect(sentence).toBeVisible({ timeout: 15000 });
    const words = page.locator('#transcriptModalBody mark.tr-sentence mark.tr-word');
    expect(await words.count()).toBeGreaterThanOrEqual(2);   // "hearing" + "guru"

    // Green computed colour on the word marks; the words sit inside the sentence.
    const wordBg = await page.evaluate(() => {
      const w = document.querySelector('#transcriptModalBody mark.tr-sentence mark.tr-word');
      return getComputedStyle(w).backgroundColor;
    });
    expect(wordBg).toBe('rgb(182, 245, 192)');   // #b6f5c0
  });

  test('45. Inline raw transcript carries the LOCALIZED Raw warning (not only the baked-in English one)', async ({ page }) => {
    // FIX 2: raw content ships an English-only baked-in disclaimer; an
    // LV-interface user saw "no raw lecture shows a disclaimer". Every raw
    // render must prepend a warning built from the localized rawTranscriptBody.
    // This block's beforeEach disables auto-install, so IDB starts empty — seed
    // ONE raw:en record directly (fast + deterministic, no library download).
    await page.goto('./');
    await waitForAppReady(page);

    const RAW_NR = '9990045';
    // Store a gzipped raw:en record in the same shape the installer writes
    // (offline-store.js getText() decompresses rec.gz), so the viewer's
    // raw:en:{nr} lookup hits it and renders the raw path.
    await page.evaluate(async (nr) => {
      const text = '<p>' + 'Seeded raw transcript sentence for the disclaimer test. '.repeat(20) + '</p>';
      const gz = await new Response(
        new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
      ).blob();
      await PPP.offlineStore.putFile({ key: 'raw:en:' + nr, packId: 'test-seed', gz: gz, raw: true });
    }, RAW_NR);

    // No per-lecture HTML on the server, so the premium fetch misses and the
    // lookup falls through to the seeded raw:en record.
    await page.route('**/transcripts/en/**', route => route.fulfill({ status: 404, body: '' }));

    // Switch the interface to Latvian and read the expected localized warning.
    await page.evaluate(() => PPP.app.setLanguage('lv'));
    const lvWarn = await page.evaluate(() => PPP.i18n.t('rawTranscriptBody').split('\n')[0]);
    expect(lvWarn).toContain('!!!');   // sanity: "BRĪDINĀJUMS!!!"

    await page.evaluate((nr) => PPP.app.openHtmlTranscriptViewer(nr, 'en'), RAW_NR);
    await page.waitForFunction(() => {
      const b = document.getElementById('transcriptModalBody');
      return b && b.textContent && b.textContent.length > 100;
    }, { timeout: 15000 });

    // The localized (LV) warning is present — proof the localized block was
    // prepended, distinct from any baked-in English disclaimer.
    await expect(page.locator('#transcriptModalBody')).toContainText(lvWarn, { timeout: 5000 });
    // And the raw body itself still rendered underneath the warning.
    await expect(page.locator('#transcriptModalBody')).toContainText('Seeded raw transcript sentence');
  });

  test('46. Missing HTML online: Raw-status keeps the raw modal, premium-status gets the "on Drive" modal', async ({ page }) => {
    // FIX 3: a premium (solid) chip whose per-lecture HTML is missing on the
    // server used to fall into the raw-txt modal (rawTranscriptTitle + Raw
    // WARNING) — wrong, because driveUrl points at the premium docx. The modal
    // is now chosen by the lecture's script status: 'Raw' keeps the raw modal;
    // anything else gets the neutral "available on Google Drive" copy.
    // This block's beforeEach disables auto-install, so IDB is empty and every
    // lookup for these nrs falls straight through to the driveUrl branch.

    // No per-lecture HTML exists on the server -> the viewer fetch misses (404,
    // a RESOLVED response, so this is treated as ONLINE, not offline).
    await page.route('**/transcripts/en/**', route => route.fulfill({ status: 404, body: '' }));
    await page.goto('./');
    await waitForAppReady(page);

    // Real nrs with known status in the meta DB: nr 1 is 'Raw', nr 455 is
    // 'Script_EN' (premium). Neither is in IDB (no install), so the lookup
    // reaches the driveUrl branch under test.
    async function openMiss(nr) {
      await page.evaluate((n) => PPP.app.openHtmlTranscriptViewer(n, 'en', null, null, 'https://drive.google.com/file/d/FAKE/view'), nr);
    }

    // (a) Premium status (Script_EN) -> new "Transcript available on Google Drive".
    await openMiss('455');
    await expect(page.locator('#transcriptModalTitle'))
      .toContainText('Transcript available on Google Drive', { timeout: 15000 });
    await expect(page.locator('#transcriptModalBody')).toContainText('not yet available inside the app');
    await expect(page.locator('#transcriptModalBody a[href*="drive.google.com"]')).toHaveCount(1);
    await page.keyboard.press('Escape');

    // (b) Raw status -> keep today's raw-txt modal (rawTranscriptTitle + WARNING).
    await openMiss('1');
    await expect(page.locator('#transcriptModalTitle'))
      .toContainText('Raw transcript (txt)', { timeout: 15000 });
    const enWarn = await page.evaluate(() => PPP.i18n.t('rawTranscriptBody').split('\n')[0]);
    await expect(page.locator('#transcriptModalBody')).toContainText(enWarn);
  });

});
