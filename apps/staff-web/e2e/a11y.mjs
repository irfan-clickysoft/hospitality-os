// Accessibility audit of the shell and the workflow pages with axe-core (WCAG 2.0/2.1/2.2 A and AA), in light and dark, English and Urdu.
// Run after flows.mjs (it needs some bookings to open). Fails on serious or critical findings; prints the rest.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { BASE, PASSWORD, session } from './lib.mjs';

const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const AXE = readFileSync(axePath, 'utf8');
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const fail = []; const notes = [];
const hira = await session('hira@sunset.local');
const pid = (await hira.get('/v1/me/properties')).items.find((p) => p.name.endsWith('Boulevard')).id;
const inHouse = (await hira.get(`/v1/properties/${pid}/reservations?view=in-house&limit=5`)).items[0];
const any = (await hira.get(`/v1/properties/${pid}/reservations?limit=5`)).items[0];

async function audit(page, name, { skip = [] } = {}) {
  await page.addScriptTag({ content: AXE });
  const r = await page.evaluate(async (skipRules) => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, rules: Object.fromEntries(skipRules.map((x) => [x, { enabled: false }])) }), skip);
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const rest = r.violations.filter((v) => !bad.includes(v));
  console.log(`${bad.length ? 'FAIL' : 'PASS'} ${name} — ${r.passes.length} rules passed, ${bad.length} serious/critical, ${rest.length} minor`);
  for (const v of bad) { console.log(`   ${v.id} (${v.impact}): ${v.help}`); for (const n of v.nodes.slice(0, 3)) console.log(`     ${n.target.join(' ')} — ${n.failureSummary?.split('\n')[1] ?? ''}`); fail.push(`${name}: ${v.id}`); }
  for (const v of rest) notes.push(`${name}: ${v.id} (${v.impact}) ×${v.nodes.length}`);
}

// the API limits sign-ins per account, so sign in once and let every context reuse that session
const first = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const fp = await first.newPage();
await fp.goto(BASE); await fp.getByLabel(/Company code/).fill('sunset'); await fp.getByLabel(/^Email/).fill('hira@sunset.local'); await fp.getByLabel(/^Password/).fill(PASSWORD); await fp.locator('form button.primary').click();
await fp.getByRole('navigation', { name: 'Main navigation' }).first().waitFor();
const state = await first.storageState(); await first.close();
for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: scheme, storageState: state });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.getByRole('navigation', { name: 'Main navigation' }).first().waitFor();
  const go = async (hash, ready) => { await page.evaluate((h) => { window.location.hash = h; }, hash); await page.waitForTimeout(900); if (ready) await ready(); };
  await go('/today', () => page.getByRole('heading', { name: 'Today', level: 1 }).waitFor()); await audit(page, `${scheme} · Today (arrivals)`);
  await go('/today?view=departures'); await audit(page, `${scheme} · Today (departures)`);
  await go('/inbox'); await audit(page, `${scheme} · Inbox`);
  await go('/rooms'); await audit(page, `${scheme} · Rooms`);
  await go('/guests?q=ma'); await audit(page, `${scheme} · Guests`);
  await go('/calendar'); await page.waitForTimeout(800); await audit(page, `${scheme} · Calendar`);
  await go('/reservations?tab=bookings'); await audit(page, `${scheme} · Reservations`);
  if (inHouse) {
    await go(`/reservations/${inHouse.reservationId}`); await page.waitForTimeout(800); await audit(page, `${scheme} · Reservation workspace`);
    await go(`/reservations/${inHouse.reservationId}?tab=timeline`); await audit(page, `${scheme} · Workspace timeline`);
    await go(`/reservations/${inHouse.reservationId}/check-out`); await page.waitForTimeout(800); await audit(page, `${scheme} · Check-out page`);
    await go(`/reservations/${inHouse.reservationId}?panel=move`); await page.waitForTimeout(1200); await audit(page, `${scheme} · Move panel`);
    await page.keyboard.press('Escape');
  }
  if (any) { await go(`/reservations/${any.reservationId}/check-in`); await page.waitForTimeout(1000); await page.getByRole('button', { name: 'Check in' }).last().click({ force: true }); await page.waitForTimeout(400); await audit(page, `${scheme} · Check-in page with errors shown`); }
  await go('/today'); await page.keyboard.press('Control+k'); await page.getByRole('dialog').waitFor(); await audit(page, `${scheme} · Command palette`); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Alerts/ }).click(); await audit(page, `${scheme} · Alerts popover`, { skip: ['target-size'] });   // the open popover sits over the page's own controls; axe counts those as obscured await page.keyboard.press('Escape');
  if (scheme === 'light') {
    await page.getByRole('button', { name: 'Your profile' }).click(); await page.getByRole('button', { name: 'اردو' }).click(); await page.waitForTimeout(600);
    await go('/today'); await audit(page, 'urdu · Today');
    if (inHouse) { await go(`/reservations/${inHouse.reservationId}`); await page.waitForTimeout(800); await audit(page, 'urdu · Reservation workspace'); }
    await page.getByRole('button', { name: 'آپ کا پروفائل' }).click(); await page.getByRole('button', { name: 'English' }).click();
    const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true, storageState: state });
    const mp = await phone.newPage();
    await mp.goto(BASE);
    await mp.locator('nav.bottomnav').waitFor(); await mp.waitForTimeout(900);
    await audit(mp, 'phone · Today');
    if (inHouse) { await mp.evaluate((h) => { window.location.hash = h; }, `/reservations/${inHouse.reservationId}`); await mp.waitForTimeout(1200); await audit(mp, 'phone · Reservation workspace'); }
    await phone.close();
  }
  await ctx.close();
}
await browser.close();
if (notes.length) console.log(`\nMinor findings (not failing):\n- ${[...new Set(notes)].join('\n- ')}`);
console.log(fail.length ? `\n${fail.length} serious/critical findings` : '\nno serious or critical accessibility findings');
process.exit(fail.length ? 1 : 0);
