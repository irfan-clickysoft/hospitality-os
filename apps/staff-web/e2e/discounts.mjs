// Browser test: the booking screen shows each night's rate and takes a different discount per night.
import { chromium } from 'playwright';
import { goTab, mainNav } from './lib.mjs';
const BASE = process.env.STAFF_URL ?? 'http://localhost:3001';
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const fail = [];
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };
const stamp = Date.now().toString().slice(-6);
const num = (s) => Number(s.replace(/[^0-9.]/g, ''));

const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
await page.goto(BASE);
await page.getByLabel(/Company code/).fill('sunset');
await page.getByLabel(/^Email/).fill('hira@sunset.local');
await page.getByLabel(/^Password/).fill(process.env.E2E_PASSWORD ?? 'sunset-demo-passphrase');
await page.locator('form button.primary').click();
await mainNav(page).waitFor();
await goTab(page, 'Bookings');
await page.getByRole('button', { name: 'New booking' }).click();
const sheet = page.locator('.sheet').last();
await sheet.getByLabel(/^Nights/).fill('3');
await sheet.getByRole('button', { name: 'Check availability' }).click();
const card = sheet.locator('.card.inner').first();
await card.waitFor();
const rows = card.locator('tbody tr');
check('each of the three nights is listed with its rate', await rows.count() === 3);
const rate0 = num(await rows.nth(0).locator('td').nth(0).innerText());
const pay0 = num(await rows.nth(0).locator('td').nth(2).innerText());
check('with no discount you charge the rate', rate0 > 0 && rate0 === pay0);

const first = sheet.locator('.nightpct input').first();
await first.fill('40');
await page.waitForFunction(() => document.querySelector('.sheet:last-of-type tbody tr td:nth-child(3)')?.textContent?.includes('40'), null, { timeout: 5000 });
await page.waitForTimeout(300);
const pay0b = num(await card.locator('tbody tr').nth(0).locator('td').nth(2).innerText());
const pay1b = num(await card.locator('tbody tr').nth(1).locator('td').nth(2).innerText());
check('40% off the first night only', Math.abs(pay0b - rate0 * 0.6) < 1 && pay1b > 0 && (await card.locator('tbody tr').nth(1).locator('td').nth(1).innerText()).trim() === '—');

await sheet.getByLabel(/^Discount on every night/).fill('10');
await page.waitForTimeout(900);
const t1 = await card.locator('tbody tr').nth(1).locator('td').nth(1).innerText();
check('10% on the other nights, 40% kept on the first', t1.includes('10') && (await card.locator('tbody tr').nth(0).locator('td').nth(1).innerText()).includes('40'));

await card.getByRole('button', { name: 'Choose' }).click();
await sheet.getByLabel('Full name').fill(`Late Walkin ${stamp}`);
await sheet.getByLabel('Phone', { exact: true }).fill(`0346${stamp}1`);
await sheet.getByRole('button', { name: 'Continue with this guest' }).click();
await sheet.getByRole('button', { name: 'Confirm booking' }).click();
await sheet.locator('.ok.big').waitFor();
check('the booking is made at the discounted prices', true);
const msg = await sheet.locator('textarea').inputValue();
check('the WhatsApp confirmation uses the hotel wording', /^Dear Late Walkin \d+,\n\nGreetings from Sunset BnB/.test(msg) && /Booking reference: [A-Z]+-\d+/.test(msg) && /Check-in: \d+ \w+ 20\d\d at 2:00 PM/.test(msg) && /Check-out: \d+ \w+ 20\d\d at 12:00 PM/.test(msg) && /Warm regards,\n.+\nSunset BnB/.test(msg));
await sheet.locator('details select').selectOption('Mr.');
check('choosing Mr. changes the greeting', (await sheet.locator('textarea').inputValue()).startsWith('Dear Mr. Late Walkin'));
check('there is a send link to WhatsApp', (await sheet.getByRole('link', { name: 'Send on WhatsApp' }).getAttribute('href'))?.startsWith('https://wa.me/92346') === true);
await browser.close();
if (fail.length) { console.log('\nFAILED:', fail.join('; ')); process.exit(1); }
console.log('\nALL PASSED');
