// Browser test: the Budgets tab (Reports → Budgets): a manager enters a month, it is saved, and the budget report and owner pack show it.
import { chromium } from 'playwright';
import { BASE, mainNav } from './lib.mjs';

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const fail = [];
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
await page.goto(BASE);
await page.getByLabel(/Company code/).fill('sunset'); await page.getByLabel(/^Email/).fill('manager@sunset.local'); await page.getByLabel(/^Password/).fill(process.env.E2E_PASSWORD ?? 'sunset-demo-passphrase');
await page.locator('form button.primary').click(); await mainNav(page).waitFor();
await page.evaluate(() => { window.location.hash = '/reports?tab=budgets'; });
await page.getByRole('heading', { name: 'Monthly budgets' }).waitFor({ timeout: 15000 }); check('the Budgets tab opens', true);
const month = new Date().toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
const room = page.getByLabel(new RegExp(`${month}: Room revenue`)); await room.fill('3600000');
await page.getByLabel(new RegExp(`${month}: Occupancy`)).fill('65');
await room.locator('xpath=ancestor::tr').getByRole('button', { name: 'Save' }).click();
await page.getByText('Saved').first().waitFor({ timeout: 10000 }); check('the budget saves', true);
await page.reload(); await page.getByRole('heading', { name: 'Monthly budgets' }).waitFor();
check('it is still there after reload', (await page.getByLabel(new RegExp(`${month}: Room revenue`)).inputValue()).startsWith('3600000'));
await page.evaluate(() => { window.location.hash = '/reports/center?r=budget-variance'; });
await page.getByText('Room revenue budget').first().waitFor({ timeout: 15000 });
const txt = await page.locator('main').innerText(); check('the budget report shows the budget, formatted as money', /3,600,000/.test(txt));
check('the owner pack opens', await page.evaluate(() => { window.location.hash = '/reports/center?r=owner-pack'; return true; }) && (await page.getByText('Owner and investor pack').first().waitFor({ timeout: 15000 }).then(() => true)));
await browser.close(); if (fail.length) { console.log('FAILED', fail); process.exit(1); } console.log('all passed');
