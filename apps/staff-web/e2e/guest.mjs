// Browser test: the guest's own booking page (no sign-in) and the hotel's answer to a request from it.
import { chromium } from 'playwright';
import { session, book, addDays, BASE } from './lib.mjs';
import { goTab, mainNav } from './lib.mjs';

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const fail = [];
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };
const stamp = Date.now().toString().slice(-6);

const hira = await session('hira@sunset.local');
const pid = (await hira.get('/v1/me/properties')).items.find((p) => p.name.endsWith('Boulevard')).id;
const bd = (await hira.get(`/v1/properties/${pid}/today`)).businessDate;
const b = await book(hira, pid, { name: `Guest Page ${stamp}`, phone: `0300${stamp}7`, arrival: addDays(bd, 3), nights: 2, type: 'DLX' });
const { token } = await hira.get(`/v1/properties/${pid}/reservations/${b.id}/guest-link`);

// the guest: a fresh browser, no sign-in
const guest = await (await browser.newContext({ viewport: { width: 390, height: 800 } })).newPage();
guest.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
await guest.goto(`${BASE}/#/b/${token}`);
await guest.getByText('Your booking is confirmed').waitFor();
check('the page shows the booking reference and the guest', (await guest.locator('.gb-ref').innerText()).includes(b.confirmationNo) && (await guest.getByText(`Guest Page ${stamp}`).count()) > 0);
check('check-in and check-out times are shown', (await guest.getByText(/from 2:00 PM/).count()) > 0 && (await guest.getByText(/until 12:00 PM/).count()) > 0);
check('no room number yet, and it says so', (await guest.getByText('Your room number will be shared before you arrive.').count()) === 1);
check('no sideways scroll on a phone', await guest.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
check('a guest page never shows the staff menu', (await guest.getByRole('navigation').count()) === 0);

await guest.getByRole('button', { name: 'Airport pick-up' }).click();
await guest.getByLabel('Time').fill('09:30');
await guest.getByLabel('Flight number').fill('pk301');
await guest.getByRole('button', { name: 'Send request' }).click();
await guest.getByText('Your requests').waitFor();
check('the request is listed as sent', (await guest.getByText('Sent', { exact: true }).count()) === 1);
await guest.getByRole('button', { name: 'Wheelchair access' }).click();
await guest.getByLabel(/Anything we should know/).fill('My father uses a wheelchair');
await guest.getByRole('button', { name: 'Send request' }).click();
await guest.waitForFunction(() => document.querySelectorAll('.gb-reqrow').length === 2);

// the hotel answers
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const staff = await ctx.newPage();
await staff.goto(BASE);
await staff.getByLabel(/Company code/).fill('sunset'); await staff.getByLabel(/^Email/).fill('hira@sunset.local'); await staff.getByLabel(/^Password/).fill(process.env.E2E_PASSWORD ?? 'sunset-demo-passphrase');
await staff.locator('form button.primary').click(); await mainNav(staff).waitFor();
await staff.evaluate(() => { window.location.hash = '/reservations?tab=requests'; });
const card = staff.locator('li.card', { hasText: 'Airport pick-up' });
await card.waitFor();
check('staff see the request with flight and time', (await card.innerText()).includes('PK301') && (await card.innerText()).includes('9:30 AM'));
await card.getByLabel('Reply to the guest').fill('Driver Asif, white Corolla');
await card.getByRole('button', { name: 'Done', exact: true }).click();
await staff.locator('li.card', { hasText: 'Airport pick-up' }).waitFor({ state: 'detached' });
check('answered requests leave the waiting list', (await staff.locator('li.card').count()) === 1);

await guest.reload();
await guest.getByText('Driver Asif, white Corolla').waitFor();
check('the guest sees the hotel’s answer', (await guest.getByText('Done', { exact: true }).count()) === 1);

await guest.getByRole('button', { name: 'اردو' }).click();
check('the page turns right-to-left in Urdu', (await guest.evaluate(() => document.documentElement.dir)) === 'rtl' && (await guest.getByText('آپ کی بکنگ کی تصدیق ہو گئی ہے').count()) === 1);

const bad = await (await browser.newContext()).newPage();
await bad.goto(`${BASE}/#/b/${'a'.repeat(32)}-${'b'.repeat(32)}`);
await bad.getByText(/This link is not valid/).waitFor();
check('a wrong link says it is not valid and shows nothing else', (await bad.getByText(/This link is not valid/).count()) === 1);
await browser.close();
if (fail.length) { console.log('\nFAILED:', fail.join('; ')); process.exit(1); }
console.log('\nALL PASSED');
