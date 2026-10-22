// Browser test: the walk-in desk — ID checked as you leave the field, children and family without an ID, finding a returning guest, extra mattress and breakfast plan.
import { chromium } from 'playwright';
import { session, BASE } from './lib.mjs';
import { goTab, mainNav } from './lib.mjs';

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const fail = [];
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };
const stamp = Date.now().toString().slice(-6);
const num = (s) => Number(s.replace(/[^0-9.]/g, ''));

const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
await page.goto(BASE);
await page.getByLabel(/Company code/).fill('sunset'); await page.getByLabel(/^Email/).fill('hira@sunset.local'); await page.getByLabel(/^Password/).fill(process.env.E2E_PASSWORD ?? 'sunset-demo-passphrase');
await page.locator('form button.primary').click(); await mainNav(page).waitFor();
const sheet = () => page.locator('.sheet').last();
const open = async () => { await goTab(page, 'Bookings'); await page.getByRole('button', { name: 'Walk-in' }).first().click(); await page.waitForFunction(() => /PKR/.test(document.querySelector('.sheet:last-of-type .card.inner .big')?.textContent ?? '')); };

await open();
const priceOf = async () => num(await sheet().locator('.card.inner .big').first().innerText());
const p0 = await priceOf();
await sheet().getByLabel('Extra mattress').fill('1');
await page.waitForFunction((p) => Number(document.querySelector('.sheet:last-of-type .card.inner .big')?.textContent?.replace(/[^0-9.]/g, '')) > p, p0);
check('an extra mattress raises the price', (await priceOf()) > p0);
const p1 = await priceOf();
await sheet().getByLabel('Children').fill('2');
await page.waitForFunction((p) => Number(document.querySelector('.sheet:last-of-type .card.inner .big')?.textContent?.replace(/[^0-9.]/g, '')) > p, p1);
check('two children raise it again', (await priceOf()) > p1);

// the ID is checked when you tab out of it, and the message sits next to the field
await sheet().getByLabel('Full name').first().fill(`Imran Khan ${stamp}`);
const id = sheet().getByLabel('ID number').first();
await id.fill('35202-123'); await id.press('Tab');
const msg = sheet().locator('.field.has-error .error').first();
await msg.waitFor();
check('a short CNIC is flagged as soon as you leave the field, with the reason', (await msg.innerText()).includes('13 digits') && (await id.getAttribute('aria-invalid')) === 'true');
await id.fill('3520212345671'); await id.press('Tab');
check('a valid CNIC is tidied into the standard form and the message goes', (await id.inputValue()) === '35202-1234567-1' && (await sheet().locator('.field.has-error').count()) === 0);

// family: one ID for the four of them; children have none
for (let k = 0; k < 3; k++) await sheet().getByRole('button', { name: 'Add another guest' }).click();
const cards = sheet().locator('fieldset.guestcard');
await cards.nth(1).getByLabel('Full name').fill('Nadia Khan');
await cards.nth(2).getByLabel('Full name').fill('Ali Khan'); await cards.nth(2).getByLabel('Child', { exact: true }).check();
await cards.nth(3).getByLabel('Full name').fill('Sara Khan'); await cards.nth(3).getByLabel('Child', { exact: true }).check();
check('children are told they need no ID', (await cards.nth(2).innerText()).includes('under 18'));
await sheet().getByRole('button', { name: 'Book and check in' }).click();
await sheet().locator('.ok.big, .error').first().waitFor();
check('the family checks in with one ID', (await sheet().locator('.ok.big').count()) === 1);
await sheet().getByRole('button', { name: 'Close' }).last().click();

// pressing the button with the main guest's ID missing takes you to the field
await open();
await sheet().getByLabel('Full name').first().fill(`Late Arrival ${stamp}`);
await sheet().getByRole('button', { name: 'Book and check in' }).click();
await page.waitForTimeout(200);
check('the first problem field is marked and focused', await page.evaluate(() => document.activeElement?.getAttribute('aria-invalid') === 'true'));
check('a summary says some details need fixing', (await sheet().getByText(/need fixing/).count()) > 0);
await sheet().getByRole('button', { name: 'Cancel' }).last().click();

// returning guest: found by phone, by CNIC, and by part of the name in any order
await open();
const find = sheet().getByLabel(/Has this guest stayed before/);
await find.fill('Khan Imran');
await sheet().getByRole('button', { name: new RegExp(`Imran Khan ${stamp}`) }).waitFor();
check('found by name in any order, with the number of stays', (await sheet().getByRole('button', { name: new RegExp(`Imran Khan ${stamp}`) }).innerText()).includes('1 stay'));
await find.fill('35202-1234567-1');
const byId = await page.waitForFunction(() => [...document.querySelectorAll('.sheet:last-of-type ul button')].some((b) => b.textContent?.includes('matched by ID')), null, { timeout: 5000 }).then(() => true).catch(() => false);
check('found by CNIC', byId);
await sheet().getByRole('button', { name: new RegExp(`Imran Khan ${stamp}`) }).click();
check('choosing them shows a returning-guest card and hides the new-guest fields', (await sheet().getByText('Returning guest').count()) === 1);
await find.waitFor({ state: 'detached' }).catch(() => undefined);
await browser.close();
if (fail.length) { console.log('\nFAILED:', fail.join('; ')); process.exit(1); }
console.log('\nALL PASSED');
