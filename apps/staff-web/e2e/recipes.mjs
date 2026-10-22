// Browser test: stock, a recipe drafted and approved with its cost, and the cook's recipe card.
import { chromium } from 'playwright';
import { BASE, goTab, mainNav } from './lib.mjs';

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const fail = [];
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };
const stamp = Date.now().toString().slice(-6);
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
await page.goto(BASE);
await page.getByLabel(/Company code/).fill('sunset'); await page.getByLabel(/^Email/).fill('manager@sunset.local'); await page.getByLabel(/^Password/).fill(process.env.E2E_PASSWORD ?? 'sunset-demo-passphrase');
await page.locator('form button.primary').click(); await mainNav(page).waitFor();
await goTab(page, 'Recipes');
await page.getByRole('heading', { name: 'Recipes & stock' }).waitFor();

// stock
await page.getByRole('button', { name: 'Stock', exact: true }).click();
await page.getByRole('button', { name: 'Add stock item' }).click();
let sheet = page.locator('.sheet').last();
await sheet.getByLabel('Name').fill(`Chicken ${stamp}`); await sheet.getByLabel('Cost', { exact: true }).fill('600');
await sheet.getByRole('button', { name: 'Save' }).click();
const row = page.locator('li', { hasText: `Chicken ${stamp}` });
await row.waitFor();
check('a stock item costed per kg is listed with its cost', (await row.innerText()).includes('600') && (await row.innerText()).includes('kg'));
await row.getByRole('button', { name: 'Receive' }).click();
sheet = page.locator('.sheet').last();
await sheet.getByLabel('Quantity').fill('5'); await sheet.getByLabel('Unit').selectOption('kg');
await sheet.getByRole('button', { name: 'Save' }).click();
await row.getByText('5000').waitFor();
check('5 kg received is shown as 5000 g', true);

// recipe
await page.getByRole('button', { name: 'Recipes', exact: true }).click();
await page.getByRole('button', { name: 'New recipe' }).click();
sheet = page.locator('.sheet').last();
await sheet.getByLabel('Name').fill(`Karahi ${stamp}`);
await sheet.getByRole('button', { name: 'Save' }).click();
sheet = page.locator('.sheet').last();
await sheet.getByRole('button', { name: 'Add ingredient' }).click();
await sheet.getByLabel('Ingredient').selectOption({ label: `Chicken ${stamp} (g)` });
await sheet.getByLabel('Quantity').fill('600');
await sheet.getByLabel('Steps').fill('Heat the oil\nCook the chicken\nFinish with ginger');
await sheet.getByLabel('Equipment').fill('Karahi');
await sheet.getByRole('button', { name: 'Save draft' }).click();
await sheet.getByText('Whole batch').waitFor();
await page.waitForFunction(() => /PKR\s?360/.test(document.querySelector('.sheet')?.innerText ?? ''));
check('the cost shows 600 g at 600 per kg = PKR 360', true);
await sheet.getByRole('button', { name: 'Approve' }).click();
await sheet.getByText('This version is fixed').waitFor();
check('approving fixes the version and offers a new one', (await sheet.getByRole('button', { name: 'New version' }).count()) === 1);
await sheet.getByRole('button', { name: 'Close' }).last().click();
await page.locator('li', { hasText: `Karahi ${stamp}` }).getByText('Approved v1').waitFor();
check('the list shows it approved', true);
check('no sideways scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
await browser.close();
console.log(fail.length ? `\nFAILED: ${fail.length}` : '\nALL PASSED'); process.exit(fail.length ? 1 : 0);
