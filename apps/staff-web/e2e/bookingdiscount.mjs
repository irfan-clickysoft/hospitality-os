// Browser test: a later booking gets the same ways to give a special price as the walk-in desk — a percentage or an amount off, or an agreed price, for the whole stay or the first night.
import { chromium } from 'playwright';
import { BASE, goTab, mainNav } from './lib.mjs';

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const fail = [];
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };
const num = (s) => Number(s.replace(/[^0-9.]/g, ''));
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1100 } })).newPage();
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
await page.goto(BASE);
await page.getByLabel(/Company code/).fill('sunset'); await page.getByLabel(/^Email/).fill('hira@sunset.local'); await page.getByLabel(/^Password/).fill(process.env.E2E_PASSWORD ?? 'sunset-demo-passphrase');
await page.locator('form button.primary').click(); await mainNav(page).waitFor();
await goTab(page, 'Bookings'); await page.getByRole('button', { name: 'New booking' }).first().click();
const sheet = page.getByRole('dialog'); await sheet.getByLabel('Nights').fill('2'); await sheet.getByRole('button', { name: 'Check availability' }).click();
const card = sheet.locator('.card.inner:has(tbody)').first(); await card.waitFor({ timeout: 15000 });
const total = async () => num(await card.locator('.big').first().innerText());
const std = await total(); check('there is a standard price', std > 0);
const give = sheet.getByLabel('Give'); const scope = sheet.getByLabel('Applies to');
await give.selectOption('off'); await sheet.getByLabel(/Amount off/).fill('2000'); await page.waitForTimeout(1200);
check('an amount off lowers the price by exactly that amount', Math.abs((await total()) - (std - 2000)) < 1);
await give.selectOption('pct'); await scope.selectOption('first'); await sheet.getByLabel(/Percent off/).fill('10'); await page.waitForTimeout(1200);
const afterFirst = await total(); check('a percentage on the first night only is less than the whole-stay price but more than nothing', afterFirst < std && afterFirst > std * 0.9);
await scope.selectOption('stay'); await page.waitForTimeout(1200);
check('the same percentage on the whole stay takes off more', (await total()) < afterFirst);
await give.selectOption('price'); await scope.selectOption('stay'); await sheet.getByLabel(/Price for the whole stay/).fill('15000'); await page.waitForTimeout(1200);
check('an agreed price for the stay is shown exactly', (await total()) === 15000);
await sheet.getByLabel(/Reason for discount/).waitFor(); check('a reason is asked for', true);
await browser.close(); if (fail.length) { console.log('FAILED', fail); process.exit(1); } console.log('all passed');
