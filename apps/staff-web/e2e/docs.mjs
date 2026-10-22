// Browser test: the document matrix on the walk-in card — kind of guest, documents seen or not available, a child's guardian, and the foreign-guest record.
import { chromium } from 'playwright';
import { BASE } from './lib.mjs';
import { goTab, mainNav } from './lib.mjs';

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const fail = [];
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };
const stamp = Date.now().toString().slice(-6);

const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
await page.goto(BASE);
await page.getByLabel(/Company code/).fill('sunset'); await page.getByLabel(/^Email/).fill('hira@sunset.local'); await page.getByLabel(/^Password/).fill(process.env.E2E_PASSWORD ?? 'sunset-demo-passphrase');
await page.locator('form button.primary').click(); await mainNav(page).waitFor();
const sheet = () => page.locator('.sheet').last();
const open = async () => { await goTab(page, 'Bookings'); await page.getByRole('button', { name: 'Walk-in' }).first().click(); await page.waitForFunction(() => /PKR/.test(document.querySelector('.sheet:last-of-type .card.inner .big')?.textContent ?? '')); };

// a Pakistani couple's child
await open();
await sheet().getByLabel('Full name').first().fill(`Imran Docs ${stamp}`);
await sheet().getByLabel('ID number').first().fill('3520212345671'); await sheet().getByLabel('ID number').first().press('Tab');
const docs0 = sheet().locator('details.docs').first();
check('the card shows the kind of guest and that a document is missing', (await docs0.locator('summary').innerText()).includes('Pakistani adult') && (await docs0.locator('summary').innerText()).includes('1 missing'));
await docs0.locator('summary').click();
await docs0.getByRole('button', { name: 'Seen' }).click();
check('marking the CNIC as seen completes the person', (await docs0.locator('summary').innerText()).includes('Complete'));

await sheet().getByRole('button', { name: 'Add another guest' }).click();
const card1 = sheet().locator('fieldset.guestcard').nth(1);
await card1.getByLabel('Full name').fill('Little Ali'); await card1.getByLabel('Child', { exact: true }).check();
const docs1 = card1.locator('details.docs');
check('a child is a Pakistani minor and needs the guardian', (await docs1.locator('summary').innerText()).includes('Pakistani minor') && (await docs1.locator('summary').innerText()).includes('2 missing'));
await docs1.locator('summary').click();
await docs1.getByLabel('Accompanying guardian').selectOption({ index: 1 });
await docs1.getByRole('button', { name: 'Seen' }).click();
check('with the guardian linked and the B-Form seen the child is complete', (await docs1.locator('summary').innerText()).includes('Complete'));
// a document that is not available needs a reason
await docs0.getByRole('button', { name: 'Not available' }).click();
check('"not available" asks why, and without a reason it stays missing', (await docs0.getByLabel('Why not').count()) === 1 && (await docs0.locator('summary').innerText()).includes('missing'));
await docs0.getByLabel('Why not').fill('Lost, police report shown');
check('with a reason it is recorded as an exception', (await docs0.locator('summary').innerText()).includes('Complete'));
await sheet().getByLabel('Children').fill('1');
await sheet().getByRole('button', { name: 'Book and check in' }).click();
await sheet().locator('.ok.big, .error').first().waitFor();
check('the family checks in even though one document was an exception', (await sheet().locator('.ok.big').count()) === 1);
await sheet().getByRole('button', { name: 'Close' }).last().click();

// a foreign guest: the foreign record fields appear and are counted
await open();
await sheet().getByLabel('Foreign guest').check();
await sheet().getByLabel('Full name').first().fill(`Tim Docs ${stamp}`);
const f0 = sheet().locator('details.docs').first();
check('a foreign guest is a Foreign adult', (await f0.locator('summary').innerText()).includes('Foreign adult'));
await f0.locator('summary').click();
check('the foreign-guest record is asked for', (await f0.getByLabel('Port of entry').count()) === 1 && (await f0.getByLabel('Local address').count()) === 1 && (await f0.getByLabel('Permitted stay until').count()) === 1);
const before = await f0.locator('summary').innerText();
await f0.getByLabel('Port of entry').fill('Karachi airport');
check('filling a detail reduces what is missing', (await f0.locator('summary').innerText()) !== before);
await browser.close();
if (fail.length) { console.log('\nFAILED:', fail.join('; ')); process.exit(1); }
console.log('\nALL PASSED');
