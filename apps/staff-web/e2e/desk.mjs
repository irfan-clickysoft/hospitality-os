// Browser test of the front-office screens against the real API (see apps/staff-web/README.md for the setup).
import { chromium } from 'playwright';
import { goTab, mainNav, setLang } from './lib.mjs';
const BASE = process.env.STAFF_URL ?? 'http://localhost:3001';
const OUT = process.argv[2] ?? '.';
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const fail = [];
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };
const stamp = Date.now().toString().slice(-6);

async function login(ctx, email) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
  await page.goto(BASE);
  await page.getByLabel(/Company code/).fill('sunset');
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel(/^Password/).fill('sunset-demo-passphrase');
  await page.locator('form button.primary').click();
  await mainNav(page).waitFor();
  return page;
}
const tab = (page, name) => goTab(page, name);
const sheet = (page) => page.locator('.sheet').last();

const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await login(ctx, 'hira@sunset.local');
check('front desk lands on Today', await page.getByRole('heading', { name: 'Today' }).count() === 1);
check('front desk sees the desk sections but not Administration', await mainNav(page).getByRole('link', { name: 'Administration' }).count() === 0 && await mainNav(page).getByRole('link', { name: 'Calendar' }).count() === 1);
await page.screenshot({ path: `${OUT}/d01-today.png` });

// cashier: open a session
await tab(page, 'Cashier');
await page.locator('main button', { hasText: /Open cashier session|Count and close/ }).first().waitFor();
if (await page.getByRole('button', { name: 'Count and close' }).count()) {                 // left open by an earlier run: count it away first
  await page.getByRole('button', { name: 'Count and close' }).click();
  await sheet(page).getByLabel('Cash you counted').fill('0');
  await sheet(page).getByRole('button', { name: 'Count and close' }).click();
  await sheet(page).getByText('Difference').waitFor();
  await sheet(page).getByRole('button', { name: 'Close' }).click();
}
await page.getByRole('button', { name: 'Open cashier session' }).first().click();
await sheet(page).getByLabel(/Cash in the drawer now/).fill('5000');
await sheet(page).getByRole('button', { name: 'Open cashier session' }).click();
await page.getByText('Opening float').waitFor();
check('cashier session open, drawer total hidden', await page.getByText('hidden until you count').count() === 1);

// new booking for tonight, one night, a new guest
await tab(page, 'Bookings');
await page.getByRole('button', { name: 'New booking' }).click();
await sheet(page).getByRole('button', { name: 'Check availability' }).click();
await sheet(page).locator('.card.inner').first().waitFor();
const priceText = await sheet(page).locator('.card.inner .big').first().innerText();
const price = priceText.replace(/[^0-9.]/g, '');
check(`quote shows a price (${priceText})`, Number(price) > 0);
check('quote shows the cancellation policy sentence', (await sheet(page).getByText(/Free cancellation until/).count()) > 0);
await page.screenshot({ path: `${OUT}/d02-quote.png` });
await sheet(page).getByRole('button', { name: 'Choose' }).first().click();
await sheet(page).getByLabel('Full name').fill(`Ali Raza ${stamp}`);
await sheet(page).getByLabel('Phone', { exact: true }).fill(`0345${stamp}1`);
await sheet(page).getByRole('button', { name: 'Continue with this guest' }).click();
await sheet(page).getByRole('button', { name: 'Confirm booking' }).click();
const conf = await sheet(page).locator('.ok.big').innerText();
check(`booking confirmed (${conf})`, /✓ BLVD-\d+/.test(conf));
await sheet(page).getByRole('button', { name: 'Open booking' }).click();
await page.getByRole('heading', { level: 1, name: new RegExp(`Ali Raza ${stamp}`) }).waitFor();
check('opening a booking lands on its workspace page', page.url().includes('#/reservations/'));

// check in (a full page inside the workspace)
await page.locator('.head-actions').getByRole('link', { name: /Check in/ }).click();
const clean = page.locator('.room-picker button:not([disabled])').filter({ hasText: /Clean(?!ing)|Ready/ });
await clean.first().waitFor();
await clean.first().click();
await page.getByLabel(/^ID number/).fill('35202-1234567-1');
await page.screenshot({ path: `${OUT}/d03-checkin.png` });
await page.getByRole('region', { name: 'Check in' }).getByRole('button', { name: 'Check in' }).click();
await page.getByText(/Checked in at \d\d:\d\d/).waitFor();
check('guest is in house', await page.getByRole('region', { name: 'Guest, stay, room and balance' }).getByText('In house').count() > 0);

// money: the bill, a payment, then check out
await page.getByRole('tab', { name: 'Bill' }).click();
await page.getByRole('button', { name: 'Take payment' }).first().click();
const pay = page.getByRole('dialog', { name: 'Take payment' });
await pay.getByLabel('Amount').fill(price);
await pay.getByRole('button', { name: 'Take payment' }).click();
await pay.waitFor({ state: 'detached' });
await page.getByText('Received').first().waitFor();
check('payment appears on the bill', await page.getByText('Received').count() > 0);
await page.screenshot({ path: `${OUT}/d04-bill.png` });
await page.getByRole('tab', { name: 'Overview' }).click();
await page.locator('.head-actions').getByRole('link', { name: /Check out/ }).click();
await page.getByLabel(/Why is the guest leaving early/).fill('Changed plans');
await page.screenshot({ path: `${OUT}/d04b-checkout.png` });
await page.getByRole('region', { name: 'Check out' }).getByRole('button', { name: 'Check out' }).click();
await page.getByText(/Checked out at \d\d:\d\d/).waitFor();
check('guest checked out with a settled bill', true);

// walk-in
await tab(page, 'Bookings');
await page.getByRole('button', { name: 'Walk-in' }).first().click();
await sheet(page).getByLabel('Full name').first().fill(`Sara Khan ${stamp}`);
await sheet(page).getByLabel('ID number').fill('42101-7654321-9');
await page.waitForFunction(() => /PKR/.test(document.querySelector('.sheet:last-of-type .card.inner .big')?.textContent ?? ''));
await page.screenshot({ path: `${OUT}/d05-walkin.png` });
await sheet(page).getByRole('button', { name: 'Book and check in' }).click();
await page.locator('.sheet').last().locator('.ok.big, .error').first().waitFor();
if (await page.locator('.sheet').last().locator('.error').count()) { console.log('WALK-IN ERROR:', await page.locator('.sheet').last().locator('.error').first().innerText()); await page.screenshot({ path: `${OUT}/d05b-walkin-error.png` }); }
check('walk-in booked and checked in', true);
await page.locator('.sheet').last().getByRole('button', { name: 'Close' }).last().click();

// rack
await tab(page, 'Rack');
await page.locator('.rack').waitFor();
await page.screenshot({ path: `${OUT}/d06-rack.png` });
check('rack shows the walk-in guest as a bar', await page.locator('.bar.st-checked_in', { hasText: 'Sara Khan' }).count() > 0);
await page.locator('.bar.st-checked_in', { hasText: 'Sara Khan' }).first().click();
await page.getByRole('heading', { level: 1, name: /Sara Khan/ }).waitFor();
check('a bar on the calendar opens the same workspace', page.url().includes('#/reservations/'));

// today shows the in-house guest
await tab(page, 'Today');
await page.getByRole('button', { name: /In house/ }).first().click();
await page.getByText(`Sara Khan ${stamp}`).first().waitFor();
check('today lists the in-house guest', true);

// cashier close with the right count
await tab(page, 'Cashier');
await page.getByRole('button', { name: 'Count and close' }).click();
await sheet(page).getByLabel('Cash you counted').fill(String(5000 + Number(price)));
await sheet(page).getByRole('button', { name: 'Count and close' }).click();
await sheet(page).getByText('Difference').waitFor();
check('cash count matches: no difference', await sheet(page).locator('.ok').count() > 0);
await page.screenshot({ path: `${OUT}/d07-cashier-closed.png` });
await sheet(page).getByRole('button', { name: 'Close' }).click();

// Urdu on the rack
await setLang(page, 'ur');
await tab(page, 'ریک');
await page.locator('.rack').waitFor();
check('rack is right-to-left in Urdu', (await page.evaluate(() => document.documentElement.dir)) === 'rtl');
await page.screenshot({ path: `${OUT}/d08-rack-urdu.png` });
await setLang(page, 'en');      // put the profile back (the choice is saved on the server)
await page.waitForTimeout(500);
await ctx.close();

// phone layout
const phone = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const p2 = await login(phone, 'hira@sunset.local');
await p2.screenshot({ path: `${OUT}/d09-phone-today.png` });
await tab(p2, 'Rack');
await p2.locator('.rack').waitFor();
await p2.screenshot({ path: `${OUT}/d10-phone-rack.png` });
await phone.close();

// manager: night audit screen
const mgr = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const p3 = await login(mgr, 'manager@sunset.local');
await tab(p3, 'Night audit');
await p3.getByText('Business date').first().waitFor();
check('night audit screen shows the status and what is in the way', await p3.locator('.card').count() > 0);
await p3.screenshot({ path: `${OUT}/d11-audit.png` });
await mgr.close();

await browser.close();
console.log(fail.length ? `\n${fail.length} FAILED` : '\nALL PASSED');
process.exit(fail.length ? 1 : 0);
