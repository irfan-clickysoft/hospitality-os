// Browser test: Administration → Roster: a manager sets a standard, adds and removes a shift, and the staffing forecast report shows it.
import { chromium } from 'playwright';
import { BASE, mainNav } from './lib.mjs';

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const fail = [];
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };
const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
await page.goto(BASE);
await page.getByLabel(/Company code/).fill('sunset'); await page.getByLabel(/^Email/).fill('manager@sunset.local'); await page.getByLabel(/^Password/).fill(process.env.E2E_PASSWORD ?? 'sunset-demo-passphrase');
await page.locator('form button.primary').click(); await mainNav(page).waitFor();
await page.evaluate(() => { window.location.hash = '/admin?tab=roster'; });
await page.getByRole('heading', { name: 'Staff roster' }).waitFor({ timeout: 15000 }); check('the Roster tab opens', true);
await page.getByLabel(/Housekeeping: Rooms per person/).fill('5'); await page.getByLabel(/Housekeeping: At least/).fill('1');
await page.getByLabel(/Housekeeping: Rooms per person/).locator('xpath=ancestor::tr').getByRole('button', { name: 'Save' }).click();
await page.getByText('Saved').first().waitFor({ timeout: 10000 }); check('the standard saves', true);
await page.getByRole('button', { name: /^Add a shift for/ }).first().click();
await page.getByLabel('Department').first().selectOption('HOUSEKEEPING');
await page.getByRole('button', { name: 'Save' }).first().click();
await page.getByText('08:00–16:00').first().waitFor({ timeout: 10000 }); check('a shift is added to the grid', true);
await page.reload(); await page.getByText('08:00–16:00').first().waitFor({ timeout: 15000 }); check('it is still there after reload', true);
await page.evaluate(() => { window.location.hash = '/reports/center?r=staffing-forecast'; });
await page.getByText('Staffing forecast').first().waitFor({ timeout: 15000 });
check('the report lists Housekeeping', await page.getByText('Housekeeping').first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false));
await page.evaluate(() => { window.location.hash = '/admin?tab=roster'; });
await page.getByRole('button', { name: /^Remove the shift for/ }).first().click(); await page.getByText('08:00–16:00').first().waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
check('the shift is removed', (await page.getByText('08:00–16:00').count()) === 0);
await browser.close(); if (fail.length) { console.log('FAILED', fail); process.exit(1); } console.log('all passed');
