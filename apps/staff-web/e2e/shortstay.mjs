// Browser test: a guest who checks in and leaves a few hours later is charged the share of the night the property sets, and the check-out page shows it.
import { chromium } from 'playwright';
import { session, book, cnic, BASE } from './lib.mjs';

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const fail = [];
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };
const stamp = Date.now().toString().slice(-6);

const mgr = await session('manager@sunset.local');
const owner = await session('owner@sunset.local');
const pid = (await mgr.get('/v1/me/properties')).items.find((p) => p.name.endsWith('Boulevard')).id;
const P = `/v1/properties/${pid}`;
const bd = (await mgr.get(`${P}/today`)).businessDate;
const prop = await owner.get(P);
await owner.patch(P, { shortStayRule: { tiers: [{ upToHours: 3, percent: 30 }, { upToHours: 6, percent: 50 }, { upToHours: 12, percent: 75 }] }, version: prop.version });

const rooms = (await mgr.get(`${P}/rooms`)).items; const free = rooms.find((r) => r.number === '203') ?? rooms[0];
await mgr.put(`${P}/housekeeping/rooms/${free.id}/status`, { status: 'CLEAN' }).catch(() => undefined);
const b = await book(mgr, pid, { name: `Nap Guest ${stamp}`, phone: `0300${stamp}6`, arrival: bd, nights: 2, type: 'DLX' });
await mgr.post(`${P}/reservations/${b.id}/rooms/${b.line}/check-in`, { roomId: free.id, occupants: [{ fullName: `Nap Guest ${stamp}`, isPrimary: true, ageGroup: 'ADULT', idType: 'CNIC', idNumber: cnic(Number(stamp.slice(-3)) + 7), nationality: 'PK' }] });
const pre = await mgr.get(`${P}/reservations/${b.id}/rooms/${b.line}/check-out-preview`);
check('the server offers the short-stay choices', pre.eligible && pre.options[0].mode === 'RULE' && pre.options[0].percent === 30);
const charge = pre.options[0].charge.amount;
await mgr.post(`${P}/reservations/${b.id}/payments`, { kind: 'PAYMENT', method: 'CARD_SLIP', amount: charge, reference: `RRN${stamp}`, approvalCode: 'AB12' }, { 'idempotency-key': `ss-${stamp}` });

const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
await page.goto(BASE);
await page.getByLabel(/Company code/).fill('sunset'); await page.getByLabel(/^Email/).fill('manager@sunset.local'); await page.getByLabel(/^Password/).fill(process.env.E2E_PASSWORD ?? 'sunset-demo-passphrase');
await page.locator('form button.primary').click(); await page.getByRole('navigation').first().waitFor();
await page.evaluate((id) => { window.location.hash = `/reservations/${id}`; }, b.id);
await page.locator('.head-actions').getByRole('link', { name: /Check out/ }).click();
await page.getByText(/Short stay: \d/).waitFor();
check('the page shows the short-stay choices with the share of the night', (await page.getByText(/30% of the night/).count()) === 1 && (await page.getByText(/The whole night/).count()) === 1);
check('the bill follows the choice: paid in full, ready to check out', (await page.getByText(/^Paid/).count()) > 0);
await page.getByLabel(/Why is the guest leaving early/).fill('Flight to catch');
await page.getByRole('region', { name: 'Check out' }).getByRole('button', { name: 'Check out' }).click();
await page.getByText(/Checked out at \d\d:\d\d/).waitFor();
check('the guest is checked out for the short-stay charge', true);
const folio = await mgr.get(`${P}/reservations/${b.id}/folio`);
check('the bill shows the part of the night that was not charged', folio.postings.some((p) => (p.description ?? '').startsWith('Short stay')) && folio.folio.balance.amount === '0.00');
check('no sideways scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
await browser.close();
console.log(fail.length ? `\nFAILED: ${fail.length}` : '\nALL PASSED'); process.exit(fail.length ? 1 : 0);
