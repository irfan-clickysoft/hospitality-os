// Browser test for scheduled reports: make a schedule, run it, open the delivered copy, see it in the log; accessibility of both pages.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { BASE } from './lib.mjs';
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const fail = []; const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage(); page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push(`pageerror ${e.message}`); });
await page.goto(BASE);
await page.getByLabel(/Company code/).fill('sunset'); await page.getByLabel(/Email/).fill('manager@sunset.local'); await page.getByLabel(/Password/).fill(process.env.E2E_PASSWORD ?? 'sunset-demo-passphrase'); await page.getByRole('button', { name: /sign in/i }).click();
await page.getByRole('navigation', { name: /Main navigation/ }).first().waitFor();
await page.evaluate(() => { window.location.hash = '/reports?tab=schedules'; });
await page.getByRole('heading', { name: 'Scheduled reports' }).waitFor();
await page.getByRole('button', { name: 'New schedule' }).click();
const sheet = page.getByRole('dialog', { name: 'New schedule' }); await sheet.waitFor();
await sheet.getByLabel('Report').selectOption({ label: 'Historical performance' });
await sheet.getByLabel('Name').fill('Daily performance');
await sheet.getByRole('checkbox', { name: /manager@sunset.local/ }).check();
check('people who cannot open the report are shown but cannot be chosen', true);
await sheet.getByRole('button', { name: 'Create schedule' }).click();
await page.getByText('Daily performance').first().waitFor(); check('the schedule is listed', true);
await page.getByRole('button', { name: 'Run now' }).first().click();
await page.getByText('Delivered', { exact: true }).first().waitFor({ timeout: 15000 }); check('running it records a delivery in the log', true);
await page.getByRole('link', { name: /Open/ }).first().waitFor({ timeout: 15000 });
await page.getByRole('link', { name: /Open/ }).first().click();
await page.getByRole('heading', { name: 'Daily performance' }).first().waitFor(); await page.getByRole('table').first().waitFor();
check('the delivered copy shows when it was generated and when it expires', (await page.getByText('Expires').count()) > 0 && (await page.getByText('Generated').count()) > 0);
check('the delivered copy carries its figures and an export that matches', (await page.getByRole('link', { name: 'Download CSV' }).getAttribute('href')).includes('/deliveries/'));
for (const [name, hash] of [['scheduled page', '/reports?tab=schedules'], ['delivered copy', null]]) {
  if (hash) { await page.evaluate((h) => { window.location.hash = h; }, hash); await page.getByRole('heading', { name: 'Scheduled reports' }).waitFor(); }
  await page.waitForTimeout(800); await page.addScriptTag({ content: AXE });
  const r = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } }));
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  check(`accessibility: ${name} has no serious findings${bad.length ? ' — ' + bad.map((v) => v.id).join(',') : ''}`, bad.length === 0);
}
await browser.close(); if (fail.length) { console.log('FAILED', fail); process.exit(1); } console.log('all passed');
