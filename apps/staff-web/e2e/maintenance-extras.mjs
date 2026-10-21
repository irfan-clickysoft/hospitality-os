// Browser test: pictures on a job, a contractor's bill through approval and payment, and a recurring job.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { session, BASE, addDays } from './lib.mjs';

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const fail = [];
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };
const stamp = Date.now().toString().slice(-6);
const png = `/tmp/fault-${stamp}.png`;
writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const pdf = `/tmp/bill-${stamp}.pdf`;
writeFileSync(pdf, '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

const mgr = await session('manager@sunset.local');
const pid = (await mgr.get('/v1/me/properties')).items.find((p) => p.name.endsWith('Boulevard')).id;
const bd = (await mgr.get(`/v1/properties/${pid}/today`)).businessDate;
const vendor = await mgr.post('/v1/maintenance/vendors', { name: `Aqua Fix ${stamp}`, trade: 'PLUMBING', phone: '0300 1112223' });
const job = await mgr.post(`/v1/properties/${pid}/work-orders`, { title: `Geyser ${stamp}`, category: 'PLUMBING', priority: 2, vendorId: vendor.id, estimatedCost: '20000' });

const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
page.on('dialog', (d) => { void d.accept(d.type() === 'prompt' ? (d.message().includes('How was it paid') ? 'BANK_TRANSFER' : d.message().includes('reference') ? 'TT-' + stamp : 'because') : undefined); });
await page.goto(BASE);
await page.getByLabel(/Company code/).fill('sunset'); await page.getByLabel(/^Email/).fill('manager@sunset.local'); await page.getByLabel(/^Password/).fill(process.env.E2E_PASSWORD ?? 'sunset-demo-passphrase');
await page.locator('form button.primary').click(); await page.getByRole('navigation').first().waitFor();
await page.evaluate(() => { window.location.hash = '/tasks?tab=maintenance'; });
await page.getByText(`Geyser ${stamp}`).click();
const sheet = page.locator('.sheet').last();

await sheet.locator('input[type=file][accept*="video"]').setInputFiles(png);
await sheet.locator('img[alt]').first().waitFor();
check('a picture is added and filed under the work', (await sheet.getByText('The work', { exact: true }).count()) === 1);

await sheet.getByRole('button', { name: 'Add a bill' }).click();
const bill = sheet.locator('div.card.inner').filter({ has: page.locator('label', { hasText: 'Bill number' }) });
await bill.getByLabel('Bill number').fill(`A-${stamp}`); await bill.getByLabel('Cost', { exact: true }).fill('25000'); await bill.getByLabel('Bill date').fill(bd);
await bill.getByRole('button', { name: 'Save' }).click();
await sheet.getByText(`#A-${stamp}`).waitFor();
check('the bill is listed and the over-estimate is flagged', (await sheet.getByText('more than the estimate').count()) === 1);
const [chooser] = await Promise.all([page.waitForEvent('filechooser'), sheet.getByRole('button', { name: 'Attach the bill' }).click()]);
await chooser.setFiles(pdf);
await sheet.getByRole('link', { name: 'View bill' }).waitFor();
check('the copy of the bill can be opened', true);
await sheet.getByRole('button', { name: 'Approve' }).last().click();
await sheet.getByRole('button', { name: 'Mark paid' }).waitFor();
await sheet.getByRole('button', { name: 'Mark paid' }).click();
await sheet.getByText('Paid by BANK_TRANSFER').waitFor();
check('the bill is approved and then paid', true);
await sheet.getByRole('button', { name: 'Close' }).last().click();

await page.getByRole('button', { name: 'Contractor bills' }).click();
await page.locator('.sheet').last().getByRole('button', { name: 'Paid', exact: true }).click();
await page.locator('.sheet').last().getByText(`#A-${stamp}`).waitFor();
check('the bills overview lists it under paid', true);
await page.locator('.sheet').last().getByRole('button', { name: 'Close' }).last().click();

await page.getByRole('button', { name: 'Recurring jobs' }).click();
const s2 = page.locator('.sheet').last();
await s2.getByRole('button', { name: 'New recurring job' }).click();
await s2.getByLabel('What is wrong').fill(`AC filter service ${stamp}`);
await s2.getByLabel('First due on').fill(addDays(bd, 2));
await s2.getByRole('button', { name: 'Save' }).last().click();
await s2.getByText(`AC filter service ${stamp}`).waitFor();
await s2.getByRole('button', { name: 'Create due jobs now' }).click();
await s2.getByText(/job\(s\) created/).waitFor();
await s2.getByRole('button', { name: 'Close' }).last().click();
await page.getByText(`AC filter service ${stamp}`).waitFor();
check('a recurring job created its job ahead of time', true);
check('no sideways scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
await browser.close();
console.log(fail.length ? `\nFAILED: ${fail.length}` : '\nALL PASSED'); process.exit(fail.length ? 1 : 0);
