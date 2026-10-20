// Browser test: a pasted guest list fills the registration card, and a gate visitor staying the night becomes a registered guest.
import { chromium } from 'playwright';
import { BASE, session, goTab, mainNav } from './lib.mjs';

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const fail = [];
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };
const stamp = Date.now().toString().slice(-6);
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
await page.goto(BASE);
await page.getByLabel(/Company code/).fill('sunset'); await page.getByLabel(/^Email/).fill('manager@sunset.local'); await page.getByLabel(/^Password/).fill(process.env.E2E_PASSWORD ?? 'sunset-demo-passphrase');
await page.locator('form button.primary').click(); await mainNav(page).waitFor();

await goTab(page, 'Bookings');
await page.getByRole('button', { name: 'Walk-in' }).first().click();
const sheet = page.locator('.sheet').last();
await sheet.getByRole('button', { name: 'Paste a guest list' }).click();
await sheet.getByLabel('Guest list').fill(`Ali Roster ${stamp}, 3520212345671\nSara Roster ${stamp}, child\nJohn Roster ${stamp}, GB, 123456789\nx`);
await sheet.getByRole('button', { name: 'Add these guests' }).click();
check('a line that cannot be read is reported', (await sheet.getByText(/Could not read 1 line/).count()) === 1);
check('the three people are added after the main guest', (await sheet.locator('fieldset.guestcard', { hasText: 'Companion' }).count()) === 3);
check('the CNIC is tidied and the child has no ID', (await sheet.getByLabel('ID number').nth(1).inputValue()) === '35202-1234567-1' && (await sheet.locator('fieldset.guestcard').nth(2).getByLabel('Child', { exact: true }).isChecked()));
await sheet.getByRole('button', { name: 'Close' }).last().click().catch(() => {});

// the gate
const api = await session('gate@sunset.local');
const pid = (await api.get('/v1/me/properties')).items.find((p) => p.name.endsWith('Boulevard')).id;
await api.post(`/v1/properties/${pid}/gate/visits`, { kind: 'VISITOR', name: `Overnight Visitor ${stamp}`, phone: `0301${stamp}9`, visiting: 'Room 101' });
await page.evaluate(() => { window.location.hash = '/tasks?tab=gate'; });
const row = page.locator('li', { hasText: `Overnight Visitor ${stamp}` });
await row.getByRole('button', { name: /register as guest/ }).click();
await row.getByText('Registered as guest').waitFor();
check('the visitor is now a registered guest', true);
await browser.close();
console.log(fail.length ? `\nFAILED: ${fail.length}` : '\nALL PASSED'); process.exit(fail.length ? 1 : 0);
