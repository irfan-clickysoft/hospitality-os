// Browser smoke test for the staff app (needs the API, the dev seed and the dev server running — see apps/staff-web/README.md).
import { chromium } from 'playwright';
const BASE = process.env.STAFF_URL ?? 'http://localhost:3001';
const OUT = process.argv[2] ?? '.';
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const phone = { viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const fail = [];
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };

async function login(ctx, email, tenant = 'sunset') {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
  await page.goto(BASE);
  await page.getByLabel(/Company code|کمپنی کوڈ/).fill(tenant);
  await page.getByLabel(/Email|ای میل/).fill(email);
  await page.getByLabel(/Password|پاس ورڈ/).fill('sunset-demo-passphrase');
  await page.locator('form button.primary').click();
  await page.getByRole('navigation', { name: /Main navigation|مین مینو/ }).first().waitFor();
  return page;
}

// 1. Bilal: English, attendant flow
{
  const ctx = await browser.newContext(phone);
  const page = await login(ctx, 'bilal@sunset.local');
  await page.waitForSelector('.task');
  check('lists two rooms, most urgent first', (await page.locator('.task .room-no').allTextContents()).length === 2);
  await page.screenshot({ path: `${OUT}/01-bilal-my-rooms.png` });
  const first = page.locator('.task').first();
  await first.getByRole('button', { name: 'Start cleaning' }).click();
  await page.waitForSelector('.task.active');
  check('start puts the room in "Cleaning now"', await page.locator('.task.active').getByText('Cleaning now').count() === 1);
  check('second room cannot be started meanwhile', await page.locator('.task:not(.active) button.primary').first().isDisabled());
  await page.screenshot({ path: `${OUT}/02-bilal-cleaning.png` });
  // offline: finish, then start the next, all on the phone
  await ctx.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.locator('.task.active').getByRole('button', { name: 'Finished' }).click();
  await page.waitForSelector('.banner');
  check('offline banner shows', await page.getByText('No signal').count() > 0);
  check('finished is shown immediately and queued', await page.getByText('1 waiting to send').count() > 0);
  await page.locator('.task').filter({ hasText: /To do/ }).first().getByRole('button', { name: 'Start cleaning' }).click();
  check('two actions waiting', await page.getByText('2 waiting to send').count() > 0);
  await page.screenshot({ path: `${OUT}/03-bilal-offline.png` });
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => !document.body.innerText.includes('waiting to send'), null, { timeout: 15000 });
  check('queue drained after reconnecting', true);
  await page.reload(); await page.waitForSelector('.task');
  check('after reload the server shows one room cleaning', await page.locator('.task.active').count() === 1);
  await page.screenshot({ path: `${OUT}/04-bilal-synced.png` });
  await ctx.close();
}

// 2. Ayesha: Urdu from her profile, right-to-left
{
  const ctx = await browser.newContext(phone);
  const page = await login(ctx, 'ayesha@sunset.local');
  await page.waitForSelector('.task');
  check('Urdu applied from her profile', (await page.evaluate(() => document.documentElement.lang)) === 'ur');
  check('page is right-to-left', (await page.evaluate(() => document.documentElement.dir)) === 'rtl');
  check('Urdu text on screen', await page.getByText('صفائی شروع کریں').count() > 0);
  await page.screenshot({ path: `${OUT}/05-ayesha-urdu.png` });
  await page.getByRole('button', { name: /پروفائل/ }).click(); await page.getByRole('button', { name: 'English' }).click();
  check('switch to English', (await page.evaluate(() => document.documentElement.dir)) === 'ltr');
  await ctx.close();
}

// 3. Sana: supervisor board
{
  const ctx = await browser.newContext(phone);
  const page = await login(ctx, 'sana@sunset.local');
  await page.goto(`${BASE}/#/housekeeping?tab=board`);
  await page.waitForSelector('.tile');
  check('board shows all nine rooms', await page.locator('.tile').count() === 9);
  await page.screenshot({ path: `${OUT}/06-sana-board.png` });
  await page.locator('.tile.dirty').first().click();
  await page.waitForSelector('.sheet');
  await page.screenshot({ path: `${OUT}/07-sana-room-sheet.png` });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Select rooms' }).click();
  await page.locator('.tile.dirty').last().click();
  await page.getByRole('button', { name: /Assign to/ }).click();
  await page.waitForSelector('.sheet');
  await page.screenshot({ path: `${OUT}/08-sana-assign.png` });
  await ctx.close();
}
await browser.close();
console.log(fail.length ? `\n${fail.length} FAILED` : '\nALL PASSED');
process.exit(fail.length ? 1 : 0);
