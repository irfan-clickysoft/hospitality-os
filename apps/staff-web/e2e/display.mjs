// Day / night and the accessibility choices: they apply at once, are remembered after a reload, work on the sign-in page, and pass the automated accessibility audit in every combination.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { BASE } from './lib.mjs';
const OUT = process.argv[2] ?? '.';
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const fail = []; const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, colorScheme: 'light' });
const page = await ctx.newPage(); page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push(`pageerror ${e.message}`); });
const attr = (n) => page.evaluate((k) => document.documentElement.getAttribute(k), n);
async function audit(name) {
  await page.waitForTimeout(400); await page.addScriptTag({ content: AXE });
  const r = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }));
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  check(`${name}: no serious accessibility findings`, bad.length === 0);
  for (const v of bad) { console.log(`   ${v.id}: ${v.help}`); for (const n of v.nodes.slice(0, 3)) console.log(`     ${n.target.join(' ')} — ${(n.failureSummary ?? '').split('\n')[1] ?? ''}`); }
}
await page.goto(BASE);
await page.screenshot({ path: `${OUT}/s1-login-day.png` });
check('the sign-in page shows the Stay360 logo', await page.getByRole('img', { name: /Stay360/ }).count() > 0);
await page.getByRole('button', { name: 'Switch to night mode' }).click();
check('night mode applies on the sign-in page', (await attr('data-theme')) === 'dark');
await page.screenshot({ path: `${OUT}/s2-login-night.png` }); await audit('sign-in, night');
await page.getByRole('button', { name: 'Switch to day mode' }).click();
await page.getByLabel(/Company code/).fill('sunset'); await page.getByLabel(/Email/).fill('hira@sunset.local'); await page.getByLabel(/Password/).fill(process.env.E2E_PASSWORD ?? 'sunset-demo-passphrase'); await page.locator('form button.primary').click();
await page.getByRole('navigation', { name: /Main navigation/ }).first().waitFor(); await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/s3-today-day.png` }); await audit('today, day');
await page.getByRole('button', { name: 'Switch to night mode' }).click(); await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/s4-today-night.png` }); await audit('today, night');
await page.reload(); await page.getByRole('navigation', { name: /Main navigation/ }).first().waitFor();
check('night mode is remembered after a reload', (await attr('data-theme')) === 'dark');
await page.getByRole('button', { name: /Your profile/ }).click(); await page.getByRole('button', { name: 'Display and accessibility' }).click();
const dlg = page.getByRole('dialog', { name: 'Display and accessibility' });
await dlg.getByLabel('Extra large').check(); check('extra large text scales the app', (await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)) === '20px');
await dlg.getByLabel('Higher contrast').check(); check('higher contrast is switched on', (await attr('data-contrast')) === 'high');
await dlg.getByLabel('Reduce motion').check(); check('reduced motion is switched on', (await attr('data-motion')) === 'reduce');
await page.screenshot({ path: `${OUT}/s5-display-panel.png` }); await audit('display panel, night, high contrast, extra large');
await dlg.getByLabel('Day', { exact: true }).check(); check('day mode from the panel', (await attr('data-theme')) === 'light');
await page.keyboard.press('Escape'); await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/s6-today-day-contrast-xl.png` }); await audit('today, day, high contrast, extra large');
await page.getByRole('button', { name: /Your profile/ }).click(); await page.getByRole('button', { name: 'Display and accessibility' }).click();
await page.getByRole('dialog', { name: 'Display and accessibility' }).getByRole('button', { name: 'Back to the defaults' }).click();
check('the defaults come back', (await attr('data-theme')) === null && (await attr('data-text')) === null && (await attr('data-contrast')) === null);
await browser.close(); if (fail.length) { console.log('FAILED', fail); process.exit(1); } console.log('all passed');
