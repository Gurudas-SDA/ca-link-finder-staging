const { test } = require('@playwright/test');

test('Tags appear under lecture name', async ({ page }) => {
  page.on('pageerror', err => console.log('[pageerror]', err.message));
  await page.goto('./');
  await page.waitForFunction(() => {
    const i = document.getElementById('searchTerm');
    return i && !i.disabled && i.placeholder && i.placeholder.includes('9');
  }, { timeout: 60000 });
  await page.waitForTimeout(3000);

  await page.fill('#searchTerm', 'bhagavad gita');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#resultsInfo strong', { timeout: 15000 });
  await page.waitForTimeout(1500);

  const info = await page.evaluate(() => {
    const tbl = document.getElementById('resultsTable');
    const rows = tbl ? tbl.querySelectorAll('tbody tr') : [];
    const samples = [];
    rows.forEach((tr, i) => {
      if (i >= 3) return;
      const ofn = tr.cells[4];
      samples.push({
        i,
        nr: tr.cells[0]?.querySelector('[data-nr]')?.getAttribute('data-nr'),
        ofn_html: ofn?.innerHTML?.substring(0, 250),
      });
    });
    return { rowCount: rows.length, samples };
  });
  console.log(JSON.stringify(info, null, 2));
});
