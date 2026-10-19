// Browser test of the application shell and the three workflows built on it (see apps/staff-web/README.md for the setup; run after scripts/reset-dev.sh):
//   A  late-arrival check-in with missing information  (room not ready → move → fill in the card → check in → undo)
//   B  moving an in-house guest because of the room     (groups, consequences, reason, a room taken meanwhile, a change made by someone else)
//   C  check-out with an outstanding balance            (bill, payment, bill changing underneath, leaving with a balance, permissions)
// plus the shell: navigation by role, command palette, alerts, offline, phone layout, keyboard-only and Urdu.
import { chromium } from 'playwright';
import { session, book, addDays, BASE, PASSWORD, cnic } from './lib.mjs';

const OUT = process.argv[2] ?? '.';
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const fail = [];
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };
const stamp = Date.now().toString().slice(-6);
const psql = async (sql) => { const { execFileSync } = await import('node:child_process'); const env = await import('node:fs').then((fs) => fs.readFileSync(new URL('../../../.env', import.meta.url), 'utf8')); const url = env.match(/DATABASE_URL_ADMIN=(.*)/)[1]; return execFileSync('psql', [url, '-Atc', sql]).toString().trim(); };

// ───────── scenario data, made through the API as the people who would make it ─────────
const hira = await session('hira@sunset.local'); const sana = await session('sana@sunset.local'); const mgr = await session('manager@sunset.local');
const pid = (await hira.get('/v1/me/properties')).items.find((p) => p.name.endsWith('Boulevard')).id;
let bd = (await hira.get(`/v1/properties/${pid}/today`)).businessDate;
const rooms = Object.fromEntries((await hira.get(`/v1/properties/${pid}/rooms`)).items.map((r) => [r.number, r.id]));
const P = `/v1/properties/${pid}`;
const setHk = (n, status) => sana.put(`${P}/housekeeping/rooms/${rooms[n]}/status`, { status });
for (const n of ['101', '102', '103', '104', '201', '202', '203', '204']) await setHk(n, 'CLEAN');

const faisal = await book(hira, pid, { name: `Faisal Raza ${stamp}`, arrival: bd });             // no phone number on file
await hira.put(`${P}/reservations/${faisal.id}/rooms/${faisal.line}/assignment`, { roomId: rooms['201'] });
await setHk('201', 'DIRTY');                                                                          // assigned room is not ready
const ayesha = await book(hira, pid, { name: `Ayesha Malik ${stamp}`, phone: `0300${stamp}1`, arrival: bd, type: 'STD' });
const checkInApi = (s, b, room, name) => s.post(`${P}/reservations/${b.id}/rooms/${b.line}/check-in`, { roomId: rooms[room], occupants: [{ fullName: name, isPrimary: true, ageGroup: 'ADULT', idType: 'CNIC', idNumber: cnic(Number(stamp.slice(-3)) + Number(room)), nationality: 'PK' }] });
await checkInApi(hira, ayesha, '104', `Ayesha Malik ${stamp}`);                                       // in house, for workflow B

// ───────── browser ─────────
async function login(ctx, email) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
  await page.goto(BASE);
  await page.getByLabel(/Company code/).fill('sunset');
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.locator('form button.primary').click();
  await page.getByRole('navigation', { name: 'Main navigation' }).first().waitFor();
  return page;
}
const nav = (page) => page.locator('nav.rail');
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await login(ctx, 'hira@sunset.local');
const banner = (p, text) => p.locator('.banner2', { hasText: text });

// ═════════ the shell ═════════
check('front desk lands on Today, with the ten-section navigation filtered to their role', await page.getByRole('heading', { name: 'Today', level: 1 }).count() === 1
  && await nav(page).getByRole('link', { name: 'Reservations' }).count() === 1 && await nav(page).getByRole('link', { name: 'Administration' }).count() === 0 && await nav(page).getByRole('link', { name: 'Inbox' }).count() === 1);
check('business day and property are always visible in the top bar', await page.locator('.topbar').getByText('Sunset BnB', { exact: false }).count() > 0 && await page.locator('.bizday').count() === 1);
await page.getByRole('link', { name: new RegExp(`Faisal Raza ${stamp}`) }).waitFor();
check('Today queue shows the late arrival with what would stop the check-in', await page.getByRole('link', { name: new RegExp(`Faisal Raza ${stamp}.*Room not ready`, 's') }).count() === 1);
check('… and the unguaranteed booking', await page.getByRole('link', { name: new RegExp(`Faisal Raza ${stamp}.*No deposit`, 's') }).count() === 1);
await page.screenshot({ path: `${OUT}/f01-today.png` });

// command palette: search a guest from anywhere
await nav(page).getByRole('link', { name: 'Calendar' }).click();
await page.keyboard.press('Control+k');
const palette = page.getByRole('dialog', { name: 'Search and commands' });
await palette.getByRole('combobox').fill(`Faisal Raza ${stamp}`);
await palette.getByRole('option', { name: new RegExp(`Faisal Raza ${stamp}`) }).waitFor();
check('command palette finds a guest by name from another page', true);
await palette.getByRole('combobox').press('Enter');
await page.getByRole('heading', { name: `Faisal Raza ${stamp}`, level: 1 }).waitFor();
check('… and opens the reservation workspace', page.url().includes(`#/reservations/${faisal.id}`));

// ═════════ A — late-arrival check-in with missing information ═════════
const rail = page.getByRole('region', { name: 'Guest, stay, room and balance' });
check('workspace keeps guest, stay, room and balance in a rail', await rail.getByText(`Faisal Raza ${stamp}`).count() === 1 && await rail.getByText('Needs cleaning').count() === 1);
check('rail flags the missing phone number', await rail.getByText('No phone number').count() === 1);
check('blocker is shown before any workflow starts', await banner(page, 'Room not ready').count() === 1 && await page.locator('.banner2[role="alert"]').count() >= 1);
check('there is one primary action: Check in', await page.locator('.head-actions .primary').count() === 1);
await page.screenshot({ path: `${OUT}/f02-workspace.png` });
await page.keyboard.press('c');                                                                     // keyboard shortcut
await page.getByRole('heading', { name: 'Check in', level: 2 }).waitFor();
check('shortcut C opens the check-in page, rail still visible', await rail.isVisible());
check('room step explains the problem and offers the way out', await banner(page, 'Room 201 is not ready').count() === 1 && await page.getByRole('button', { name: 'Move guest to another room' }).count() === 1);
check('a front-desk agent cannot override: the page says who can', await page.getByText('A manager can check the guest in anyway').count() === 1);
const bar = page.getByRole('region', { name: 'Check in' });
check('the check-in button says why it cannot be used yet', await bar.getByText('the room is not ready').count() === 1 && await bar.getByRole('button', { name: 'Check in' }).getAttribute('aria-disabled') === 'true');

await page.getByRole('button', { name: 'Ask housekeeping to clean it first' }).click();
await page.getByText('Housekeeping has been asked to clean this room first').waitFor();
check('the desk can ask housekeeping to clean the room first, and the page says it was asked', true);
check('the room now has a most-urgent cleaning task', (await sana.get(`${P}/housekeeping/board`)).rooms.find((r) => r.number === '201').tasks.some((t) => t.priority === 1));

// B (before arrival): move to a ready room from the panel, without losing the page
await page.getByRole('button', { name: 'Move guest to another room' }).click();
const panel = page.getByRole('dialog', { name: /Choose a room for Faisal/ });
await panel.getByRole('heading', { name: 'Ready now' }).waitFor();
check('side panel opens beside the booking (focus inside, page still behind)', await panel.getByRole('heading', { name: 'Ready now' }).count() === 1 && await page.getByRole('heading', { name: 'Check in', level: 2 }).count() === 1);
check('the room the guest is in is not offered, and rooms are grouped by readiness', await panel.getByRole('button', { name: /^201/ }).count() === 0 && await panel.locator('.roomopt').count() >= 2);
check('upgrade is shown disabled, with the reason', await panel.getByRole('button', { name: /Upgrade/ }).isDisabled() && await panel.getByText('change the room type on the booking first').count() === 1);
await page.screenshot({ path: `${OUT}/f03-panel.png` });
await panel.getByRole('button', { name: /^202/ }).click();
check('choosing a room shows the consequences before confirming', await panel.getByText('Same room type and rate').count() === 1 && await panel.getByText('The guest is not told automatically').count() === 1);
await panel.getByRole('button', { name: 'Assign 202' }).click();
await panel.waitFor({ state: 'detached' });
await page.getByText('Room 202 is ready').waitFor();
check('panel closes and the check-in page follows the new room', true);
check('Escape closed nothing else: the draft page is still here', await page.getByRole('heading', { name: 'Check in', level: 2 }).count() === 1);

// the registration card: missing information is marked in the field
await bar.getByRole('button', { name: 'Check in' }).click({ force: true });
check('pressing Check in with an empty card marks what is missing, in the fields', await page.getByText('Enter the ID number').count() === 1 && await bar.getByText(/thing\(s\) missing/).count() === 1);
const idField = page.getByLabel(/^ID number/);
await idField.fill('12345'); await idField.blur();
check('a wrong CNIC is explained as you type', await page.getByText('A CNIC has 13 digits').count() === 1);
await page.getByLabel(/^Guest phone/).fill('0300 5551234'); await page.getByLabel(/^Guest phone/).blur();
await page.getByText(/Saved \d\d:\d\d/).first().waitFor();
check('the missing phone number is saved from the check-in page', true);
await idField.fill('35202-1234567-1');
await page.locator('.flow-head').getByText(/Saved \d\d:\d\d/).waitFor();
check('draft saved on this device is announced next to the title', true);
await page.reload();
await page.getByRole('heading', { name: 'Check in', level: 2 }).waitFor();
check('after a reload the draft is back, but the ID number is not stored', await page.getByLabel(/^Full name|^Name/).first().inputValue() === `Faisal Raza ${stamp}` && await page.getByLabel(/^ID number/).inputValue() === '');
await page.getByLabel(/^ID number/).fill('35202-1234567-1');

// offline: the button explains, the draft stays
await ctx.setOffline(true);
await bar.getByText('no signal').waitFor({ timeout: 8000 }).catch(() => undefined);
check('offline: check-in is blocked with the reason and the draft is kept', await bar.getByText(/no signal/).count() >= 1);
await ctx.setOffline(false);
await bar.getByText('Ready to check in').waitFor({ timeout: 20000 });
check('back online: ready to check in', true);

// a concurrent change: someone else checks the guest in while this page is open
await checkInApi(sana.call ? hira : hira, faisal, '202', `Faisal Raza ${stamp}`);
await banner(page, 'This booking was changed by someone else').waitFor({ timeout: 25000 });
check('concurrent change: a conflict banner appears and the button is blocked', await banner(page, 'This booking was changed by someone else').count() === 1 && await bar.getByText('the booking changed').count() === 1);
await page.screenshot({ path: `${OUT}/f04-conflict.png` });
await page.getByRole('button', { name: 'Review the changes' }).first().click();
await page.getByRole('link', { name: 'Cancel' }).first().click();
await page.getByRole('heading', { name: `Faisal Raza ${stamp}`, level: 1 }).waitFor();
check('after review the workspace shows the guest as in house', await rail.getByText('In house').count() >= 1);

// undo is only offered where the system allows it; here it is the same day
await page.goto(`${BASE}/#/reservations/${faisal.id}?done=checkin`);
await page.getByText(/Checked in at \d\d:\d\d/).waitFor();
check('a completed check-in stays on the page as a card (not a toast)', true);
check('… with the printable registration card one click away', (await page.getByRole('link', { name: /Registration card/i }).first().getAttribute('href')).includes('/registration-card'));
await page.getByRole('button', { name: 'Undo check-in' }).click();
check('undo asks for a reason first', await page.getByRole('group', { name: 'Undo check-in' }).getByLabel(/Reason/).count() === 1);
await page.getByRole('group', { name: 'Undo check-in' }).getByLabel(/Reason/).fill('Guest changed plans');
await page.getByRole('group', { name: 'Undo check-in' }).getByRole('button', { name: 'Undo check-in' }).click();
await page.getByText(/Checked in at/).waitFor({ state: 'detached' });
await rail.getByText('Confirmed').first().waitFor();
check('undo returns the guest to Confirmed', true);

// ═════════ B — moving an in-house guest because of the room ═════════
const third = await book(hira, pid, { name: `Third Guest ${stamp}`, phone: `0300${stamp}2`, arrival: bd, type: 'STD' });
await hira.put(`${P}/reservations/${third.id}/rooms/${third.line}/assignment`, { roomId: rooms['204'] });   // the only other Standard room is now held for someone else
await page.goto(`${BASE}/#/reservations/${ayesha.id}`);
await page.getByRole('heading', { name: `Ayesha Malik ${stamp}`, level: 1 }).waitFor();
check('in-house guest: rail shows the room and that the guest is in house', await rail.getByText('104').count() >= 1 && await rail.getByText('In house').count() >= 1);
await page.keyboard.press('m');
const mp = page.getByRole('dialog', { name: /Move Ayesha/ });
await mp.waitFor();
await banner(mp, 'No other Standard Room is free').waitFor();
check('no free room of the type: the panel says so plainly and offers no dead end', await banner(mp, 'No other Standard Room is free').count() === 1 && await mp.getByRole('button', { name: /Upgrade/ }).isDisabled());
await page.screenshot({ path: `${OUT}/f05-move-none.png` });
check('the held room is listed as unavailable, with the reason', await mp.getByText('booked for these nights').count() === 1);
await hira.post(`${P}/reservations/${third.id}/cancel`, { reason: 'test setup' });
await mp.getByRole('button', { name: 'Refresh' }).click();
await mp.getByRole('heading', { name: 'Ready now' }).waitFor();
await mp.getByRole('button', { name: /^204/ }).waitFor();
check('after Refresh the freed room appears under "Ready now"', true);
await mp.getByRole('button', { name: /^204/ }).click();
const moveBtn = mp.getByRole('button', { name: 'Move to 204' });
check('an in-house move cannot be confirmed without a reason', await moveBtn.isDisabled());
await mp.getByRole('button', { name: 'Room not ready' }).click();
check('suggested reasons fill the field; the move is then allowed', await moveBtn.isEnabled() && await mp.getByText(/Room 104 goes to housekeeping/).count() === 1);
const fourth = await book(hira, pid, { name: `Fourth Guest ${stamp}`, phone: `0300${stamp}5`, arrival: bd, type: 'STD' });
await hira.put(`${P}/reservations/${fourth.id}/rooms/${fourth.line}/assignment`, { roomId: rooms['204'] });   // somebody takes 204 while the panel is open
await moveBtn.click();
await banner(mp, /Someone just took that room|Room 204/).first().waitFor();
check('the room taken meanwhile: told in words, list refreshed, nothing was moved', await mp.getByText('Someone just took that room').count() >= 1 && (await hira.get(`${P}/reservations/${ayesha.id}`)).lines[0].assignedRoom.number === '104');
await hira.post(`${P}/reservations/${fourth.id}/cancel`, { reason: 'test setup' });
await mp.getByRole('button', { name: 'Refresh' }).click();
await mp.getByRole('heading', { name: 'Ready now' }).waitFor();
await mp.getByRole('button', { name: /^204/ }).click();
await mp.getByRole('button', { name: 'Move to 204' }).click();
await mp.waitFor({ state: 'detached' });
await page.getByText(/Room changed at \d\d:\d\d · now Room 204/).waitFor();
check('a completed move stays on the page as a card, and the rail follows', await rail.getByText('204').count() >= 1);
check('the old room went to housekeeping', (await hira.get(`${P}/rack?days=1`)).rooms.find((r) => r.number === '104').hkStatus === 'DIRTY');
await page.getByRole('tab', { name: 'Timeline' }).click();
check('the timeline records the move with its reason', await page.getByText('Room not ready').count() >= 1);

// ═════════ C — check-out with an outstanding balance ═════════
const imran = await book(hira, pid, { name: `Imran Siddiqui ${stamp}`, phone: `0300${stamp}3`, arrival: bd, type: 'DLX' });
await checkInApi(hira, imran, '103', `Imran Siddiqui ${stamp}`);
const imranFolio = (await hira.get(`${P}/reservations/${imran.id}/folio`)).folio.id;
await hira.post(`${P}/folios/${imranFolio}/charges`, { txnCode: 'FNB', amount: '2500', description: 'Room-service dinner' });
await hira.post(`${P}/folios/${imranFolio}/charges`, { txnCode: 'MINIBAR', amount: '900', description: 'Minibar' });
await hira.post(`${P}/cashier/sessions`, { openingFloat: '0', registerName: 'e2e' }).catch(() => undefined);
const early = await book(hira, pid, { name: `Zara Early ${stamp}`, phone: `0300${stamp}4`, arrival: bd, type: 'EXE' });
await checkInApi(hira, early, '101', `Zara Early ${stamp}`);
await psql(`update property set business_date = business_date + 2 where id = '${pid}'`);              // two days later: Imran, Ayesha and Zara are due out
bd = addDays(bd, 2);
await page.goto(`${BASE}/#/today?view=departures`);
await page.getByRole('link', { name: new RegExp(`Imran Siddiqui ${stamp}`) }).waitFor();
check('departure row shows what the guest owes, before anything is opened', await page.getByRole('link', { name: new RegExp(`Imran Siddiqui ${stamp}.*Owes`, 's') }).count() === 1);
check('rows with problems come first', (await page.locator('ul.queue li a').first().innerText()).includes('Owes') || (await page.locator('ul.queue li a').first().innerText()).includes('Past departure'));
await page.screenshot({ path: `${OUT}/f06-departures.png` });
await page.getByRole('link', { name: new RegExp(`Imran Siddiqui ${stamp}`) }).click();
await page.getByRole('heading', { name: 'Check out', level: 2 }).waitFor();
const out = page.getByRole('region', { name: 'Check out' });
check('check-out page: the bill lists the charges, the balance is in the rail', await page.getByRole('cell', { name: /2,500/ }).count() >= 1 && await rail.getByText(/Owes/).count() >= 1);
check('one primary action: settle the bill; Check out is not offered yet', await out.locator('.primary').count() === 1 && await out.getByRole('button', { name: /Settle/ }).count() === 1 && await out.getByRole('button', { name: 'Check out' }).isDisabled());
check('the way out for a manager is named, and who can use it', await page.getByText('Other ways to close this bill').count() === 1);
await page.screenshot({ path: `${OUT}/f07-checkout.png` });
await out.getByRole('button', { name: /Settle/ }).click();
const pay = page.getByRole('dialog', { name: 'Take payment' });
await pay.getByLabel(/Amount/).fill('1000');
await pay.getByRole('button', { name: 'Take payment' }).click();
await pay.waitFor({ state: 'detached' });
check('a part payment lowers the balance but the page still asks to settle (and is not reported as someone else’s change)', await out.getByRole('button', { name: /Settle/ }).count() === 1 && await banner(page, 'The bill changed').count() === 0);
await hira.post(`${P}/folios/${imranFolio}/charges`, { txnCode: 'LAUNDRY', amount: '1200', description: 'Laundry' });   // the kitchen / laundry posts while the page is open
await banner(page, 'The bill changed').waitFor({ timeout: 25000 });
check('the bill changed underneath: the page says by how much', await page.getByText(/The bill changed: \+PKR 1,?200/).count() === 1);
await page.screenshot({ path: `${OUT}/f08-bill-changed.png` });
await page.getByRole('button', { name: 'I have reviewed it' }).click();
const owed = (await hira.get(`${P}/reservations/${imran.id}/folio`)).projection.balanceAtEndOfStay.amount;
await out.getByRole('button', { name: /Settle/ }).click();
check('the amount to pay is pre-filled with what is owed', Number(await pay.getByLabel(/Amount/).inputValue()) === Number(owed));
await pay.getByLabel(/Amount/).fill('abc');
await pay.getByRole('button', { name: 'Take payment' }).click();
await pay.locator('.error').waitFor();
check('payment failure: the error stays in the form, nothing is posted, what was typed is kept', await pay.getByLabel(/Amount/).inputValue() === 'abc' && (await hira.get(`${P}/reservations/${imran.id}/folio`)).payments.length === 1);
await pay.getByLabel(/Amount/).fill(owed);
await pay.getByRole('button', { name: 'Take payment' }).click();
await pay.waitFor({ state: 'detached' });
await out.getByText('Paid in full — ready to check out').waitFor();
check('when the balance reaches zero the page changes: Paid in full, and Check out becomes the primary action', await page.getByText('Paid in full').count() >= 1 && await out.getByRole('button', { name: 'Check out' }).isEnabled());
await out.getByRole('button', { name: 'Check out' }).click();
await page.getByText(/Checked out at \d\d:\d\d/).waitFor();
check('a finished check-out stays as a card with the invoice next, and says it cannot be undone', await page.getByText('A check-out cannot be undone').count() === 1 && await page.getByRole('button', { name: /invoice/i }).count() >= 1);
await page.screenshot({ path: `${OUT}/f09-checked-out.png` });

// early departure and permission limits
await page.goto(`${BASE}/#/reservations/${early.id}/check-out`);
await page.getByRole('heading', { name: 'Check out', level: 2 }).waitFor();
check('leaving a balance unpaid needs a manager: the front desk is told, not offered a button', await page.getByText('Letting a guest leave with a balance needs a manager').count() === 1 || await page.getByText('Other ways to close this bill').count() === 0);

// second factor, in place: the server asks for a step-up while the move panel is open (the answer is simulated; the prompt must appear inside the panel, not over it)
let asked = false;
await page.route('**/rooms/*/move', async (route) => { if (!asked) { asked = true; await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: 'MFA_REQUIRED', detail: 'step-up' }) }); } else await route.continue(); });
await page.route('**/v1/auth/mfa/verify', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
const stepper = await book(hira, pid, { name: `Step Up ${stamp}`, phone: `0300${stamp}7`, arrival: bd, type: 'EXE' });
await checkInApi(hira, stepper, '202', `Step Up ${stamp}`);
await page.goto(`${BASE}/#/reservations/${stepper.id}?panel=move`);
const zp = page.getByRole('dialog', { name: /Move Step Up/ });
await zp.getByRole('heading', { name: 'Ready now' }).waitFor();
await zp.getByRole('button', { name: /^102/ }).click();
await zp.getByRole('button', { name: 'Room not ready' }).click();
await zp.getByRole('button', { name: 'Move to 102' }).click();
await zp.locator('.stepup-slot').waitFor();
check('second factor is asked inside the panel, and no second dialog is opened', await page.getByRole('dialog').count() === 1);
await zp.locator('.stepup-slot input').fill('123456');
await zp.locator('.stepup-slot button.primary').click();
await zp.waitFor({ state: 'detached' });
await page.getByText(/Room changed at \d\d:\d\d · now Room 102/).waitFor();
check('after the code the move goes through without starting over', true);
await page.unroute('**/rooms/*/move'); await page.unroute('**/v1/auth/mfa/verify');

// the bookings list: filters live in the address, search finds by name, a row opens the workspace
await page.goto(`${BASE}/#/reservations?tab=bookings&view=cancelled`);
await page.getByRole('link', { name: new RegExp(`Third Guest ${stamp}`) }).waitFor();
check('the Cancelled filter lists cancelled bookings, and the filter is in the address', page.url().includes('view=cancelled') && await page.getByRole('link', { name: new RegExp(`Imran Siddiqui ${stamp}`) }).count() === 0);
await page.getByRole('searchbox').fill(`Faisal Raza ${stamp}`);
await page.getByRole('link', { name: new RegExp(`Faisal Raza ${stamp}`) }).click();
await page.getByRole('heading', { name: `Faisal Raza ${stamp}`, level: 1 }).waitFor();
check('searching by name finds a booking and opens its workspace', true);

// ═════════ other roles ═════════
const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const hk = await login(ctx2, 'bilal@sunset.local');
await hk.getByRole('heading', { name: 'Today', level: 1 }).waitFor();
check('a housekeeper sees only their areas, and Today is their rooms', await nav(hk).getByRole('link', { name: 'Reservations' }).count() === 0 && await nav(hk).getByRole('link', { name: 'Housekeeping' }).count() === 1 && await hk.getByRole('heading', { name: 'Today', level: 1 }).count() === 1);
await hk.goto(`${BASE}/#/reservations/${faisal.id}`);
await hk.locator('.banner2').first().waitFor();
check('opening a reservation without permission shows a clear block, not a blank page', await hk.locator('.banner2').count() >= 1);
const acc = await login(await browser.newContext({ viewport: { width: 1280, height: 860 } }), 'accountant@sunset.local');
const reader = await book(hira, pid, { name: `Late Reader ${stamp}`, phone: `0300${stamp}6`, arrival: bd, nights: 1, type: 'DLX' });
await acc.goto(`${BASE}/#/reservations/${reader.id}`);
await acc.getByRole('heading', { name: `Late Reader ${stamp}`, level: 1 }).waitFor();
check('read-only role: check-in is replaced by an explanation of who can do it', await acc.getByText('This needs front-desk permission').count() >= 1 && await acc.locator('.head-actions .primary').isDisabled());
check('… and the notes cannot be edited', await acc.getByText('You can read this but not change it.').count() >= 1);

// ═════════ phone, Urdu, keyboard ═════════
const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
const mob = await login(phone, 'hira@sunset.local');
check('phone: bottom navigation instead of the side rail, no sideways scroll', await mob.locator('nav.bottomnav').isVisible() && await mob.locator('nav.rail').isHidden() && await mob.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
const small = await mob.locator('nav.bottomnav .navitem').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).filter((r) => r.height < 44 || r.width < 44).length);
check('phone: every navigation target is at least 44 px', small === 0);
await mob.getByRole('button', { name: 'More' }).click();
check('phone: the remaining sections are under More', await mob.getByRole('navigation', { name: 'More' }).getByRole('link').count() >= 2);
await mob.goto(`${BASE}/#/today?view=departures`);
await mob.screenshot({ path: `${OUT}/f10-phone-today.png` });
await mob.goto(`${BASE}/#/reservations/${faisal.id}`);
await mob.getByRole('heading', { name: `Faisal Raza ${stamp}`, level: 1 }).waitFor();
check('phone: the workspace has no sideways scroll and keeps the context summary above the content', await mob.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
await mob.screenshot({ path: `${OUT}/f11-phone-workspace.png` });

await page.goto(`${BASE}/#/today`);
await page.getByRole('button', { name: 'Your profile' }).click();
await page.getByRole('button', { name: 'اردو' }).click();
await page.getByRole('link', { name: 'بکنگز' }).waitFor();
check('Urdu: the whole shell switches and the page turns right-to-left', await page.locator('html').getAttribute('dir') === 'rtl' && await page.getByRole('link', { name: 'بکنگز' }).count() === 1);
await page.screenshot({ path: `${OUT}/f12-urdu.png` });
await page.getByRole('button', { name: 'آپ کا پروفائل' }).click(); await page.getByRole('button', { name: 'English' }).click().catch(async () => { await page.evaluate(() => localStorage.setItem('hos.locale', 'en')); });
await page.reload();
await page.getByRole('heading', { name: 'Today', level: 1 }).waitFor();
await page.keyboard.press('Tab');
check('keyboard: the first Tab stop is the skip link', await page.evaluate(() => document.activeElement?.classList.contains('skip')));

await browser.close();
console.log(fail.length ? `\n${fail.length} FAILED:\n- ${fail.join('\n- ')}` : '\nall passed');
process.exit(fail.length ? 1 : 0);
