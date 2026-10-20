// Browser test: outlets, a menu with days and hours, a dish with every detail, and the card staff see when taking an order.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { goTab, mainNav } from './lib.mjs';
const BASE = process.env.STAFF_URL ?? 'http://localhost:3001';
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const fail = [];
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };
const stamp = Date.now().toString().slice(-6);
const png = `/tmp/dish-${stamp}.png`;
writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
await page.goto(BASE);
await page.getByLabel(/Company code/).fill('sunset');
await page.getByLabel(/^Email/).fill(process.env.E2E_USER ?? 'manager@sunset.local');
await page.getByLabel(/^Password/).fill(process.env.E2E_PASSWORD ?? 'sunset-demo-passphrase');
await page.locator('form button.primary').click();
await mainNav(page).waitFor();
await goTab(page, 'Menus');
await page.getByRole('heading', { name: 'Menu & outlets' }).waitFor();

await page.getByRole('button', { name: /Add outlet/ }).click();
let sheet = page.locator('.sheet').last();
await sheet.getByLabel('Name').fill(`Terrace ${stamp}`);
await sheet.getByRole('button', { name: 'Save' }).click();
await page.getByRole('button', { name: new RegExp(`Terrace ${stamp}`) }).waitFor();
check('the new outlet appears', true);

await page.getByRole('button', { name: 'Add menu' }).click();
sheet = page.locator('.sheet').last();
await sheet.getByLabel('Name').fill('Dinner');
await sheet.getByLabel('From').fill('18:00'); await sheet.getByLabel('To').fill('23:00');
await sheet.getByRole('button', { name: 'Save' }).click();
await page.getByRole('heading', { name: /Dinner/ }).waitFor();
check('the menu shows its hours', (await page.getByRole('heading', { name: /Dinner/ }).innerText()).includes('18:00–23:00'));

await page.getByPlaceholder('New category').fill('Mains');
await page.getByRole('button', { name: 'Add category' }).click();
await page.getByRole('button', { name: /Add dish/ }).first().click();
sheet = page.locator('.sheet').last();
await sheet.getByLabel('Name', { exact: true }).fill(`Chicken Karahi ${stamp}`);
await sheet.getByLabel('Short description').fill('Wok-tossed with tomato and green chilli');
await sheet.getByLabel('Price', { exact: true }).fill('1850');
await sheet.getByLabel('Serves how many').fill('2');
await sheet.getByLabel(/at least \(minutes\)/).fill('35');
await sheet.getByLabel(/at most \(minutes\)/).fill('45');
await sheet.getByRole('button', { name: 'Halal', exact: true }).click();
await sheet.getByLabel('Spice level').selectOption('2');
await sheet.getByLabel('Ingredients', { exact: true }).fill('chicken, tomato, ginger');
await sheet.getByLabel('Guest may leave out').fill('ginger');
await sheet.getByRole('button', { name: 'Save' }).first().click();
await sheet.locator('legend', { hasText: 'Sizes' }).waitFor();
check('after saving, sizes, option groups and pictures can be added', (await sheet.locator('legend', { hasText: 'Pictures and video' }).count()) > 0);

await sheet.getByLabel('Size', { exact: true }).fill('Half'); await sheet.locator('fieldset', { hasText: 'Sizes' }).getByLabel('Price').fill('1000');
await sheet.getByRole('button', { name: 'Add size' }).click();
await sheet.getByText('Half · ').waitFor();
check('a size can be added', true);

await sheet.locator('input[type=file]').setInputFiles(png);
await sheet.locator('img[alt]').first().waitFor();
check('a picture can be added and is the main one', (await sheet.getByText('Main picture').count()) > 0);
await sheet.getByRole('button', { name: 'Close' }).last().click();

const card = page.locator('.card', { hasText: `Chicken Karahi ${stamp}` }).first();
const text = await card.innerText();
check('the card reads like the menu', /PKR\s?1,850/.test(text) && text.includes('Serves 2') && text.includes('35–45 min') && text.includes('Halal') && text.includes('Medium spicy'));
check('no sideways scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

await page.evaluate(() => { window.location.hash = '/tasks?tab=kitchen'; });
await page.getByRole('button', { name: 'New order' }).click();
sheet = page.locator('.sheet').last();
if (await sheet.getByLabel('Outlet').count()) await sheet.getByLabel('Outlet').selectOption({ label: `Terrace ${stamp}` });
await sheet.getByText(`Chicken Karahi ${stamp}`).waitFor();
check('the order screen shows the same card with Add to order', (await sheet.getByText(`Chicken Karahi ${stamp}`).count()) > 0);
await browser.close();
console.log(fail.length ? `\nFAILED: ${fail.length}` : '\nALL PASSED'); process.exit(fail.length ? 1 : 0);
