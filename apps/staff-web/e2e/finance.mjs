// Browser test: Finance → load the chart, prepare a journal voucher, send it for approval; the preparer cannot approve it; the trial balance agrees.
// Run after scripts/reset-dev.sh: it enrols the owner's second factor.
import { chromium } from 'playwright';
import { createHmac } from 'node:crypto';
import { session, BASE } from './lib.mjs';

const b32 = (s) => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const c of s.replace(/=+$/, '')) bits += A.indexOf(c).toString(2).padStart(5, '0'); const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); };
const totp = (secret, step) => { const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(step)); const h = createHmac('sha1', b32(secret)).update(m).digest(); const o = h[h.length - 1] & 15; return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000).padStart(6, '0'); };
const stepNow = () => Math.floor(Date.now() / 30_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const fail = [];
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };

const owner = await session('owner@sunset.local');
const { secret } = await owner.post('/v1/auth/mfa/enroll');
const s0 = stepNow(); await owner.post('/v1/auth/mfa/confirm', { code: totp(secret, s0) });
await sleep((s0 + 1) * 30_000 - Date.now() + 1500);                       // a code is accepted once: sign in with the next one
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1100 } })).newPage();
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
await page.goto(BASE);
await page.getByLabel(/Company code/).fill('sunset'); await page.getByLabel(/^Email/).fill('owner@sunset.local'); await page.getByLabel(/^Password/).fill(process.env.E2E_PASSWORD ?? 'sunset-demo-passphrase');
await page.locator('form button.primary').click();
await page.getByLabel('Enter your 6-digit code').waitFor({ timeout: 8000 }).catch(async () => { console.log('NO MFA FIELD:', (await page.locator('body').innerText()).slice(0, 400)); throw new Error('mfa'); });
await page.getByLabel('Enter your 6-digit code').fill(totp(secret, stepNow()));
await page.locator('form button.primary').click();
await page.getByRole('navigation').first().waitFor({ timeout: 8000 }).catch(async () => { console.log('LOGIN STUCK:', (await page.locator('main').innerText()).slice(0, 300)); throw new Error('login'); });
await page.evaluate(() => { window.location.hash = '/finance?tab=accounts'; });
await page.getByRole('heading', { name: 'Chart of accounts' }).waitFor({ timeout: 15000 }); check('the Finance section opens', true);
await page.getByRole('button', { name: 'Load the standard hotel chart' }).click();
await page.getByText('Cash in Hand').first().waitFor({ timeout: 15000 }); check('the standard chart loads', true);
await page.evaluate(() => { window.location.hash = '/finance?tab=posting'; });
await page.getByRole('heading', { name: 'PMS posting' }).waitFor({ timeout: 15000 });
await page.getByRole('button', { name: 'Turn on' }).click();
await page.getByText(/Posting entries dated from/).first().waitFor({ timeout: 15000 }); check('automatic posting turns on', true);
check('each kind of money has its account set', (await page.getByLabel('Cash received').inputValue()) === '1010');
check('hotel records and the books agree', await page.getByText(/They agree/).first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false));
await page.evaluate(() => { window.location.hash = '/finance?tab=banks'; });
await page.getByRole('heading', { name: 'Banks' }).waitFor({ timeout: 15000 }); check('the Banks tab opens', true);
await page.evaluate(() => { window.location.hash = '/finance?tab=cash'; });
await page.getByRole('heading', { name: 'Cash and petty cash' }).waitFor({ timeout: 15000 });
await page.getByLabel('Branch').last().selectOption({ index: 1 }); await page.getByLabel('Account name').fill('Front desk cash');
await page.getByRole('button', { name: 'Add a cash drawer' }).last().click();
await page.getByText('Front desk cash').first().waitFor({ timeout: 15000 }); check('a cash drawer is added', true);
await page.evaluate(() => { window.location.hash = '/finance?tab=vouchers'; });
await page.getByRole('button', { name: 'New journal voucher' }).click();
await page.getByLabel('What it is for').fill('Repair paid in cash');
await page.getByLabel('Account 1').selectOption('5100'); await page.getByLabel('Debit 1').fill('15000');
await page.getByLabel('Account 2').selectOption('1010'); await page.getByLabel('Credit 2').fill('15000');
await page.getByText('Balanced').first().waitFor({ timeout: 5000 }); check('the form says it balances', true);
await page.getByRole('button', { name: 'Save as draft' }).click();
await page.getByRole('button', { name: 'Send for approval' }).click();
await page.getByRole('button', { name: 'Approve and post' }).waitFor({ timeout: 10000 }); check('it is waiting for approval', true);
await page.getByRole('button', { name: 'Approve and post' }).click();
await page.getByText(/someone else has to approve it/).first().waitFor({ timeout: 10000 }); check('the person who prepared it cannot approve it', true);
await page.screenshot({ path: '/tmp/finance-voucher.png' });
await page.evaluate(() => { window.location.hash = '/finance?tab=reports'; });
await page.getByText(/trial balance agrees/).first().waitFor({ timeout: 15000 }); check('the trial balance agrees (nothing posted yet)', true);
await browser.close(); if (fail.length) { console.log('FAILED', fail); process.exit(1); } console.log('all passed');
