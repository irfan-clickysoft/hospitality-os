// Browser test: the guest messages written from real bookings and payments, and the receipt message offered right after a payment.
import { chromium } from 'playwright';
import { session, book, addDays, BASE } from './lib.mjs';
import { mainNav } from './lib.mjs';

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const fail = [];
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };
const stamp = Date.now().toString().slice(-6);

const hira = await session('hira@sunset.local');
const pid = (await hira.get('/v1/me/properties')).items.find((p) => p.name.endsWith('Boulevard')).id;
const bd = (await hira.get(`/v1/properties/${pid}/today`)).businessDate;
await hira.post(`/v1/properties/${pid}/cashier/sessions`, { openingFloat: '0', registerName: 'e2e' }).catch(() => undefined);
const b = await book(hira, pid, { name: `Msg Guest ${stamp}`, phone: `0300${stamp}8`, arrival: addDays(bd, 2), nights: 2, type: 'DLX' });

const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
await page.goto(BASE);
await page.getByLabel(/Company code/).fill('sunset'); await page.getByLabel(/^Email/).fill('hira@sunset.local'); await page.getByLabel(/^Password/).fill(process.env.E2E_PASSWORD ?? 'sunset-demo-passphrase');
await page.locator('form button.primary').click(); await mainNav(page).waitFor();
await page.evaluate((id) => { window.location.hash = `/reservations/${id}`; }, b.id);
await page.getByRole('heading', { name: new RegExp(b.confirmationNo) }).first().waitFor().catch(() => undefined);

// the picker offers the messages; the confirmation is written from the booking
await page.locator('details', { hasText: 'Confirmation message for the guest' }).locator('summary').click();
const box = page.locator('details textarea').first();
await box.waitFor();
await page.waitForFunction(() => document.querySelector('details textarea')?.value?.includes('Booking reference'));
const text = await box.inputValue();
check('the confirmation is in the hotel wording with the booking reference and a link', text.startsWith(`Dear Msg Guest ${stamp},`) && text.includes(`Booking reference: ${b.confirmationNo}`) && /\/#\/b\/[0-9a-f]{32}-/.test(text));

// take a payment, then the receipt message is offered with the real receipt number
await page.locator('body').click({ position: { x: 5, y: 5 } }); await page.keyboard.press('p');
await page.getByRole('dialog', { name: 'Take payment' }).getByLabel('Amount').fill('5000');
await page.getByRole('dialog', { name: 'Take payment' }).getByRole('button', { name: 'Take payment' }).click();
await page.getByText(/Payment recorded · RCT-/).waitFor();
await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some((t) => t.value.includes('Amount received')));
const pay = await page.evaluate(() => [...document.querySelectorAll('textarea')].find((t) => t.value.includes('Amount received')).value);
check('the payment message has the amount, method, a receipt number and what is still owed', pay.includes('Amount received: PKR 5,000') && pay.includes('Payment method: Cash') && /Receipt number: RCT-[A-Z]+-\d\d-\d{5}/.test(pay) && /Remaining balance: PKR [\d,]+/.test(pay));
check('the guest can be messaged straight from here', (await page.getByRole('link', { name: 'Send on WhatsApp' }).last().getAttribute('href'))?.startsWith('https://wa.me/92300') === true);
await browser.close();
if (fail.length) { console.log('\nFAILED:', fail.join('; ')); process.exit(1); }
console.log('\nALL PASSED');
