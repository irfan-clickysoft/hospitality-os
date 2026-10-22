// Browser test: a maintenance request from the front desk, its approval and hand-over to a contractor, and the grouped lists.
import { chromium } from 'playwright';
import { session, BASE } from './lib.mjs';

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const fail = [];
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };
const stamp = Date.now().toString().slice(-6);

const mgr = await session('manager@sunset.local');
const pid = (await mgr.get('/v1/me/properties')).items.find((p) => p.name.endsWith('Boulevard')).id;
const vendor = await mgr.post('/v1/maintenance/vendors', { name: `Cool Air Services ${stamp}`, trade: 'AC', contactName: 'Imran', phone: '0300 1112223', contractRef: 'SLA-26-01', slaResponseHours: 4, slaFixHours: 24 });

async function login(email) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
  await page.goto(BASE);
  await page.getByLabel(/Company code/).fill('sunset'); await page.getByLabel(/^Email/).fill(email); await page.getByLabel(/^Password/).fill(process.env.E2E_PASSWORD ?? 'sunset-demo-passphrase');
  await page.locator('form button.primary').click(); await page.getByRole('navigation').first().waitFor();
  return page;
}
const sheet = (p) => p.locator('.sheet').last();

// front desk asks for work
const desk = await login('hira@sunset.local');
await desk.evaluate(() => { window.location.hash = '/tasks?tab=maintenance'; });
await desk.getByRole('button', { name: 'Request maintenance' }).click();
await sheet(desk).locator('select').first().selectOption('PREVENTIVE');
await sheet(desk).locator('input').first().fill(`Fumigate lobby ${stamp}`);
await sheet(desk).getByLabel('More details').fill('Ants near the reception desk');
await sheet(desk).locator('select').nth(1).selectOption('FUMIGATION');
await sheet(desk).getByLabel(/Estimated cost/).fill('6000');
check('a requester is not offered who does the job', (await sheet(desk).getByLabel('Who does the work').count()) === 0);
await sheet(desk).getByRole('button', { name: 'Send request' }).click();
await desk.getByText(`Fumigate lobby ${stamp}`).waitFor();
check('the request shows as awaiting approval', (await desk.locator('li', { hasText: `Fumigate lobby ${stamp}` }).innerText()).includes('Awaiting approval'));

// the property admin approves and gives it to the contractor
const adm = await login('manager@sunset.local');
await adm.evaluate(() => { window.location.hash = '/tasks?tab=maintenance'; });
await adm.getByRole('button', { name: /Awaiting approval/ }).click();
await adm.getByText(`Fumigate lobby ${stamp}`).click();
await sheet(adm).getByLabel('Who does the work').selectOption({ label: `Cool Air Services ${stamp} (AC)` });
await sheet(adm).getByRole('button', { name: 'Approve' }).click();
await sheet(adm).getByText(/Contractor: Cool Air Services/).waitFor();
check('approval gave the job to the contractor with the estimate kept', (await sheet(adm).innerText()).includes('Contractor: Cool Air Services') && (await sheet(adm).innerText()).includes('6,000'));
await sheet(adm).getByRole('button', { name: 'Message the technician or contractor' }).click();
const text = await sheet(adm).locator('textarea').inputValue();
check('the message to the contractor names the job and where', text.startsWith('Hello Imran (Cool Air Services') && text.includes(`Fumigate lobby ${stamp}`) && text.includes('preventive maintenance'));
check('it opens WhatsApp on the contractor’s number', (await sheet(adm).getByRole('link', { name: 'Send on WhatsApp' }).getAttribute('href'))?.startsWith('https://wa.me/923001112223') === true);
await sheet(adm).getByRole('button', { name: 'Close' }).first().click().catch(() => undefined);
await adm.keyboard.press('Escape');

// grouped by contractor
await adm.getByLabel('Group by').selectOption('vendor');
await adm.getByRole('button', { name: `Cool Air Services ${stamp}` }).waitFor();
check('grouped by contractor, the contractor’s open work is counted', (await adm.locator('table tbody tr', { hasText: `Cool Air Services ${stamp}` }).innerText()).includes('6,000'));
await adm.getByRole('button', { name: `Cool Air Services ${stamp}` }).click();
const only = await adm.waitForFunction(() => document.querySelectorAll('ul.rows li').length === 1, null, { timeout: 5000 }).then(() => true).catch(() => false);
check('choosing a group lists only its jobs', only);
await browser.close();
if (fail.length) { console.log('\nFAILED:', fail.join('; ')); process.exit(1); }
console.log('\nALL PASSED');
