// Browser test: the walk-in and new-booking windows only close with the ✕ — a click outside or the Escape key must not throw away a half-filled form.
import { chromium } from 'playwright';
import { BASE, goTab, mainNav } from './lib.mjs';

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const fail = [];
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
await page.goto(BASE);
await page.getByLabel(/Company code/).fill('sunset'); await page.getByLabel(/^Email/).fill('hira@sunset.local'); await page.getByLabel(/^Password/).fill(process.env.E2E_PASSWORD ?? 'sunset-demo-passphrase');
await page.locator('form button.primary').click(); await mainNav(page).waitFor();
await goTab(page, 'Bookings');
const dialog = () => page.getByRole('dialog');

// walk-in
await page.getByRole('button', { name: 'Walk-in' }).first().click();
const name = dialog().getByLabel('Full name').first(); await name.waitFor(); await name.fill('Typed Before Click');
await page.mouse.click(6, 6);                                                    // the dimmed area outside the window
await page.keyboard.press('Escape');
check('a click outside and Escape leave the walk-in window open', (await dialog().count()) === 1);
check('what was typed is still there', (await dialog().getByLabel('Full name').first().inputValue()) === 'Typed Before Click');
await dialog().getByRole('button', { name: 'Close' }).last().click(); await page.waitForTimeout(300);
check('the ✕ closes it', (await dialog().count()) === 0);

// new booking
await page.getByRole('button', { name: 'New booking' }).first().click(); await dialog().waitFor();
await dialog().getByLabel('Nights').fill('3');
await page.mouse.click(6, 6); await page.keyboard.press('Escape');
check('a click outside and Escape leave the booking window open', (await dialog().count()) === 1);
check('the nights typed are still there', (await dialog().getByLabel('Nights').inputValue()) === '3');
await dialog().getByRole('button', { name: 'Close' }).last().click(); await page.waitForTimeout(300);
check('the ✕ closes it', (await dialog().count()) === 0);
await browser.close(); if (fail.length) { console.log('FAILED', fail); process.exit(1); } console.log('all passed');
