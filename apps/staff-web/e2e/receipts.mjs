// Browser test: the hotel's look, a guest sending a bank-transfer slip, the desk recording the money from it, and the branded receipt behind a private link.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { session, book, addDays, BASE } from './lib.mjs';

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const fail = [];
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };
const stamp = Date.now().toString().slice(-6);
const png = `/tmp/slip-${stamp}.png`;
writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

const mgr = await session('manager@sunset.local');
const pid = (await mgr.get('/v1/me/properties')).items.find((p) => p.name.endsWith('Boulevard')).id;
const bd = (await mgr.get(`/v1/properties/${pid}/today`)).businessDate;
const b = await book(mgr, pid, { name: `Slip Guest ${stamp}`, phone: `0300${stamp}5`, arrival: addDays(bd, 30 + (Number(stamp) % 200)), nights: 2, type: 'DLX' });
const { token } = await mgr.get(`/v1/properties/${pid}/reservations/${b.id}/guest-link`);

const staff = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
staff.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
await staff.goto(BASE);
await staff.getByLabel(/Company code/).fill('sunset'); await staff.getByLabel(/^Email/).fill('manager@sunset.local'); await staff.getByLabel(/^Password/).fill(process.env.E2E_PASSWORD ?? 'sunset-demo-passphrase');
await staff.locator('form button.primary').click(); await staff.getByRole('navigation').first().waitFor();

// the look (set through the API: the Properties screen needs the owner, who must set up a second factor before using a browser)
const owner = await session('owner@sunset.local');
const prop = await owner.get(`/v1/properties/${pid}`);
await owner.patch(`/v1/properties/${pid}`, { address: `12 Seaview Road ${stamp}`, receiptFooter: `Thank you ${stamp}`, brandColor: '#0a6c74', version: prop.version });
{
  const fd = new FormData(); fd.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), 'logo.png');
  const login = await fetch(`${BASE}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ tenant: 'sunset', email: 'owner@sunset.local', password: process.env.E2E_PASSWORD ?? 'sunset-demo-passphrase' }) });
  const csrf = (await login.json()).csrfToken; const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const up = await fetch(`${BASE}/v1/properties/${pid}/branding/logo`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, origin: BASE }, body: fd });
  check('the logo uploads', up.status === 201);
}

// the guest sends a slip
const guest = await (await browser.newContext({ viewport: { width: 390, height: 800 } })).newPage();
guest.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
await guest.goto(`${BASE}/#/b/${token}`);
await guest.getByText('Paid by bank transfer?').waitFor();
await guest.getByLabel('Amount sent').fill('10000'); await guest.getByLabel('Your bank').fill('Meezan'); await guest.getByLabel('Transfer reference').fill(`IBFT ${stamp}`);
await guest.locator('input[type=file]').setInputFiles(png);
await guest.getByText('We have received your slip').waitFor();
await guest.getByText('Received, being checked').waitFor();
check('the guest sees their slip is being checked', true);
check('no sideways scroll on a phone', await guest.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

// the desk records the money from it
await staff.evaluate(() => { window.location.hash = '/reservations?tab=requests'; });
const card = staff.locator('li.card', { hasText: `Slip Guest ${stamp}` }).filter({ hasText: `IBFT ${stamp}` });
await card.waitFor();
await card.getByRole('button', { name: 'Record the payment' }).click();
const sheet = staff.locator('.sheet').last();
check('the form is filled from what the guest wrote', (await sheet.getByLabel('Bank reference').inputValue()) === `IBFT ${stamp}` && (await sheet.getByLabel('Amount').inputValue()) === '10000.00');
const acct = sheet.locator('select').first();
await acct.waitFor({ timeout: 5000 }).catch(() => undefined);
if (await acct.count()) await acct.selectOption({ index: 1 });
await sheet.getByRole('button', { name: 'Save' }).click();
await staff.locator('.sheet').waitFor({ state: 'detached' });
await guest.reload();
await guest.getByText('Payment recorded').waitFor();
check('the guest sees the payment was recorded', true);

// the receipt: for staff, and behind a private link
const pay = (await mgr.get(`/v1/properties/${pid}/reservations/${b.id}/folio`)).payments[0];
await staff.goto(`${BASE}/v1/properties/${pid}/documents/payment/${pay.id}`);
const body = await staff.locator('body').innerText();
check('the receipt carries the hotel’s address, footer and receipt number', body.includes(`12 Seaview Road ${stamp}`) && body.includes(`Thank you ${stamp}`) && body.includes(pay.receiptNo));
check('a bank transfer is marked as awaiting confirmation', body.includes('AWAITING BANK CONFIRMATION'));
const { url } = await mgr.post(`/v1/properties/${pid}/documents/links`, { kind: 'PAYMENT', refId: pay.id });
const anon = await (await browser.newContext({ viewport: { width: 390, height: 800 } })).newPage();
await anon.goto(url.startsWith('http') ? url : `${BASE}${url}`);
check('the private link opens the same receipt without signing in', (await anon.locator('body').innerText()).includes(pay.receiptNo));
check('the page has a print button', (await anon.getByRole('button', { name: 'Print or save as PDF' }).count()) === 1);
check('no sideways scroll on the receipt', await anon.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
await browser.close();
console.log(fail.length ? `\nFAILED: ${fail.length}` : '\nALL PASSED'); process.exit(fail.length ? 1 : 0);
