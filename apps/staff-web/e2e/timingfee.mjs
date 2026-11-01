// Browser test: an early arrival shows the fee decision on the check-in page; the desk charges the suggested fee and it lands on the bill.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { session, book, BASE } from './lib.mjs';
// the dev database is set up by scripts/reset-dev.sh; property settings are changed directly because the demo accounts here do not hold the property-management right
const sql = (q) => execSync('su postgres -c "psql hos_dev -q"', { input: q }).toString();
const fail = []; const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };
const hira = await session('hira@sunset.local');
const pid = (await hira.get('/v1/me/properties')).items.find((p) => p.name.endsWith('Boulevard')).id; const P = `/v1/properties/${pid}`;
const prop = await hira.get(P);
// a standard check-in time at the very end of the day makes any arrival today early; steps: half a night for any amount of earliness up to a day
sql(`UPDATE property SET check_in_time = '23:59', timing_fee_rule = '{"early":[{"upToMinutes":1440,"percent":50}],"late":[]}'::jsonb WHERE id = '${pid}';`);
const b = await book(hira, pid, { name: 'Early Bird', phone: `0300${String(Date.now()).slice(-7)}`, arrival: prop.businessDate, nights: 1 });
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage(); page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push(`pageerror ${e.message}`); });
await page.goto(BASE);
await page.getByLabel(/Company code/).fill('sunset'); await page.getByLabel(/Email/).fill('hira@sunset.local'); await page.getByLabel(/Password/).fill(process.env.E2E_PASSWORD ?? 'sunset-demo-passphrase'); await page.getByRole('button', { name: /sign in/i }).click();
await page.getByRole('navigation', { name: /Main navigation/ }).first().waitFor();
await page.goto(`${BASE}/#/reservations/${b.id}/check-in`);
const card = page.getByRole('group', { name: 'Early check-in' }); await card.waitFor();
check('an early arrival shows the fee and says it must be decided', (await card.innerText()).includes('before the standard check-in time') && (await card.innerText()).includes('before you continue'));
check('a front desk agent cannot waive it, only charge it', (await card.getByRole('button', { name: /^No fee$/ }).count()) === 0 && (await card.getByRole('button', { name: /^Charge / }).count()) === 1);
await card.getByRole('button', { name: /^Charge / }).click();
await card.getByText(/Charged .* to the bill/).waitFor(); check('the fee is charged', true);
const f = await hira.get(`${P}/reservations/${b.id}/folio`);
check('and it is on the guest bill', f.postings.some((x) => x.txnCode === 'MISC' && /Early check-in fee/.test(x.description)));
sql(`UPDATE property SET check_in_time = '14:00', timing_fee_rule = NULL WHERE id = '${pid}';`);
await browser.close(); if (fail.length) { console.log('FAILED', fail); process.exit(1); } console.log('all passed');
