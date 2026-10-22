// Browser test: giving a person several roles at once from a small-hotel preset, and taking several away together.
// Run after scripts/reset-dev.sh: it enrols the owner's second factor, which later scripts that sign the owner in through the API would then need.
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
const stamp = Date.now().toString().slice(-6);

const owner = await session('owner@sunset.local');
const { secret } = await owner.post('/v1/auth/mfa/enroll');
const s0 = stepNow(); await owner.post('/v1/auth/mfa/confirm', { code: totp(secret, s0) });
const person = await owner.post('/v1/users', { email: `roles${stamp}@sunset.local`, fullName: `Small Hotel Manager ${stamp}`, locale: 'en' });

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
await page.evaluate(() => { window.location.hash = '/admin?tab=staff'; });
await page.getByText(`Small Hotel Manager ${stamp}`).click();
const sheet = page.locator('.sheet').last();
await sheet.getByRole('button', { name: 'Manager who runs the property' }).click();
const ticked = await sheet.locator('fieldset', { hasText: 'Roles' }).locator('input[type=checkbox]:checked').count();
check('a preset ticks several roles', ticked >= 4);
check('the combined access is listed', (await sheet.getByText(/Together these roles allow \d+ things/).count()) === 1);
check('it says a second person is still needed for some steps', (await sheet.getByText(/never skips a check/).count()) === 1);
await sheet.getByRole('button', { name: new RegExp(`Give ${ticked} role`) }).click();
await sheet.getByText(/role\(s\) given/).waitFor();
await page.waitForFunction((n) => document.querySelectorAll('.sheet:last-of-type ul.plain li').length === n, ticked, { timeout: 10000 }).catch(() => undefined);
check('all the roles are given in one go', (await sheet.locator('ul.plain li').count()) === ticked);

// take two away together
const boxes = sheet.locator('ul.plain li input[type=checkbox]');
await boxes.nth(0).check(); await boxes.nth(1).check();
await sheet.getByLabel('Reason').fill('Moved to the other property');
await sheet.getByRole('button', { name: /Remove 2 selected role/ }).click();
await page.waitForFunction((n) => document.querySelectorAll('.sheet:last-of-type ul.plain li').length === n, ticked - 2);
check('two roles are taken away together', true);
check('no sideways scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
await browser.close();
console.log(fail.length ? `\nFAILED: ${fail.length}` : '\nALL PASSED'); process.exit(fail.length ? 1 : 0);
