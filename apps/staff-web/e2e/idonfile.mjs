// Browser test: a returning guest's ID is offered at check-in (masked) and used with one tap, so the number is not typed again.
import { chromium } from 'playwright';
import { session, book, addDays, BASE, mainNav } from './lib.mjs';

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const fail = [];
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };
const stamp = Date.now().toString().slice(-6);
const s = await session('hira@sunset.local'); const m = await session('manager@sunset.local');
const pid = (await s.get('/v1/me/properties')).items.find((p) => p.name.endsWith('Boulevard')).id; const P = `/v1/properties/${pid}`;
const rack = await s.get(`${P}/rack?days=2`); const bd = rack.businessDate; const exe = rack.roomTypes.find((x) => x.code === 'EXE').id;
const free = rack.rooms.filter((r) => r.roomTypeId === exe && !r.stays.length);
for (const r of free.slice(0, 2)) await m.put(`${P}/housekeeping/rooms/${r.id}/status`, { status: 'CLEAN' });
const a = await book(s, pid, { name: `Returning Guest ${stamp}`, phone: `0301${stamp}7`, arrival: bd, nights: 2 });
await s.post(`${P}/reservations/${a.id}/rooms/${a.line}/check-in`, { roomId: free[0].id, occupants: [{ fullName: `Returning Guest ${stamp}`, isPrimary: true, idType: 'CNIC', idNumber: '3520212345671', nationality: 'PK' }] });
// the same guest books again for today (another room)
const q = await s.post(`${P}/quotes`, { arrival: bd, departure: addDays(bd, 1), adults: 2, children: 0, residency: 'RESIDENT' });
const opt = q.options.find((o) => o.roomType.code === 'EXE');
const b = await s.post(`${P}/reservations`, { guestId: a.guestId, source: 'PHONE', lines: [{ quoteToken: opt.quoteToken }] }, { 'idempotency-key': `e2e-${stamp}` });
await s.put(`${P}/reservations/${b.id}/rooms/${b.lines[0].id}/assignment`, { roomId: free[1].id });

const page = await (await browser.newContext({ viewport: { width: 1280, height: 1100 } })).newPage();
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
await page.goto(BASE);
await page.getByLabel(/Company code/).fill('sunset'); await page.getByLabel(/^Email/).fill('hira@sunset.local'); await page.getByLabel(/^Password/).fill(process.env.E2E_PASSWORD ?? 'sunset-demo-passphrase');
await page.locator('form button.primary').click(); await mainNav(page).waitFor();
await page.evaluate((id) => { window.location.hash = `/reservations/${id}/check-in`; }, b.id);
const offer = page.getByRole('group', { name: 'ID on file' }); await offer.waitFor({ timeout: 15000 });
check('the ID on file is offered, masked', (await offer.innerText()).includes('*****-*******-1') && !(await offer.innerText()).includes('35202'));
await offer.getByRole('button', { name: 'Use this ID' }).click();
await page.getByText(/Using the ID on file/).waitFor(); check('using it replaces the ID fields', (await page.getByLabel(/^ID number/).count()) === 0);
await page.getByRole('button', { name: /^Check in$/ }).last().click();
await page.getByText(/is checked in|Checked in|checked in/).first().waitFor({ timeout: 15000 }); check('the guest checks in without typing the ID', true);
const g = await s.get(`${P}/reservations/${b.id}/rooms/${b.lines[0].id}/guests`); check('the new stay has the ID (masked in this view)', g.items[0].idNumber === '*****-*******-1');

// the walk-in desk offers it too, once the returning guest is picked
await page.evaluate(() => { window.location.hash = '/reservations?tab=bookings'; });
await page.getByRole('button', { name: 'Walk-in' }).first().click();
const sheet = page.getByRole('dialog'); await sheet.getByLabel(/stayed before/i).fill(`Returning Guest ${stamp}`);
await sheet.locator('button.pick').first().click();
const offer2 = sheet.getByRole('group', { name: 'ID on file' }); await offer2.waitFor({ timeout: 15000 }); check('the walk-in desk offers the ID on file for a returning guest', (await offer2.innerText()).includes('*****-*******-1'));
await offer2.getByRole('button', { name: 'Use this ID' }).click(); await sheet.getByText(/Using the ID on file/).waitFor(); check('and uses it with one tap', true);
await browser.close(); if (fail.length) { console.log('FAILED', fail); process.exit(1); } console.log('all passed');
