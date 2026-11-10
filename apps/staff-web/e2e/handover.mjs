// Browser test: the Handover tab: the front desk writes a note with an open item, the manager sees it, ticks the item and marks it read.
import { chromium } from 'playwright';
import { BASE, mainNav } from './lib.mjs';

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const fail = [];
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };
const login = async (email) => { const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage(); page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
  await page.goto(BASE); await page.getByLabel(/Company code/).fill('sunset'); await page.getByLabel(/^Email/).fill(email); await page.getByLabel(/^Password/).fill(process.env.E2E_PASSWORD ?? 'sunset-demo-passphrase'); await page.locator('form button.primary').click(); await mainNav(page).waitFor();
  await page.evaluate(() => { window.location.hash = '/reservations?tab=handover'; }); await page.getByRole('heading', { name: 'Shift handover' }).waitFor({ timeout: 15000 }); return page; };
const stamp = Date.now().toString().slice(-5);
const hira = await login('hira@sunset.local');
await hira.getByLabel(/What the next shift should know/).fill(`Room 101 waits for a plumber ${stamp}`);
await hira.getByLabel('Open item 1').fill(`Call the plumber back ${stamp}`);
await hira.getByRole('button', { name: 'Leave handover' }).click();
await hira.getByText(`Room 101 waits for a plumber ${stamp}`).waitFor({ timeout: 10000 }); check('the handover appears for its author', true);
check('the author cannot mark their own as read', (await hira.getByRole('button', { name: 'Mark as read' }).count()) === 0);
const mgr = await login('manager@sunset.local');
const card = mgr.locator('li.card', { hasText: `Room 101 waits for a plumber ${stamp}` }); await card.waitFor({ timeout: 10000 }); check('the manager sees it, not read yet', (await card.getByText('Not read yet').count()) === 1);
await card.getByRole('checkbox').click(); await card.getByText(/Omar Sheikh/).waitFor({ timeout: 10000 });      // the list reloads after the tick, so wait for who ticked it
await card.getByRole('button', { name: 'Mark as read' }).click();
await mgr.locator('li.card', { hasText: `Room 101 waits for a plumber ${stamp}` }).getByText(/Read by/).waitFor({ timeout: 10000 }); check('it is marked read and the item ticked', true);
await browser.close(); if (fail.length) { console.log('FAILED', fail); process.exit(1); } console.log('all passed');
