// Browser test for the owner's back-office tabs and the conference room (needs the API, the dev seed and the dev server running — see apps/staff-web/README.md).
// Run after scripts/reset-dev.sh:  node apps/staff-web/e2e/office.mjs ./shots
import { chromium } from 'playwright';
const BASE = process.env.STAFF_URL ?? 'http://localhost:3001';
const OUT = process.argv[2] ?? '.';
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const fail = [];
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };

const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
await page.goto(BASE);
await page.getByLabel(/Company code|کمپنی کوڈ/).fill('sunset');
await page.getByLabel(/Email|ای میل/).fill('owner@sunset.local');
await page.getByLabel(/Password|پاس ورڈ/).fill('sunset-demo-passphrase');
await page.locator('form button.primary').click();
await page.locator('nav.tabs').waitFor();

// 1. every tab opens without a crash or an error line
const tabs = await page.locator('nav.tabs button').allTextContents();
check('the owner has the back-office tabs', ['Conference room', 'Kitchen', 'Reports', 'Staff', 'Companies'].every((x) => tabs.includes(x)));
for (const name of tabs) {
  await page.locator('nav.tabs button', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).click();
  await page.waitForTimeout(500);
  const crashed = await page.getByText(/Something went wrong|Unexpected Application Error/).count();
  check(`tab "${name}" opens`, crashed === 0);
}

// 2. conference room: set up the space and prices, book a hire on its own bill, mark it done, take a payment
await page.locator('nav.tabs button', { hasText: /^Conference room$/ }).click();
await page.getByRole('button', { name: 'Spaces and prices' }).click();
await page.getByLabel('Name', { exact: true }).fill('Conference room');
await page.getByLabel('Per hour').fill('5000'); await page.getByLabel('Half day (up to 4 h)').fill('15000'); await page.getByLabel('Full day (up to 12 h)').fill('25000');
await page.getByRole('button', { name: 'Add space' }).click();
await page.getByText('Per hour: PKR 5,000').waitFor();
check('space saved with its prices', await page.getByText('Half day (up to 4 h): PKR 15,000').count() === 1);
await page.getByRole('button', { name: 'Calendar' }).click();
await page.getByRole('button', { name: 'New hire' }).first().click();
await page.getByLabel('What is the event?').fill('Board meeting');
await page.getByLabel('Booked by').fill('Mr Khan');
await page.getByLabel('From').fill('00:00'); await page.getByLabel('Until').fill('02:00');
await page.getByRole('button', { name: /Half day/ }).click();
await page.screenshot({ path: `${OUT}/20-new-hire.png` });
await page.getByRole('button', { name: 'Book', exact: true }).click();
await page.getByText('Board meeting').first().waitFor();
check('hire is on the calendar', await page.getByText('00:00–02:00 · Board meeting').count() === 1);
check('amount shown before tax', await page.getByText('PKR 15,000').count() > 0);
// a second hire that overlaps is refused with a clear message
await page.getByRole('button', { name: 'New hire' }).first().click();
await page.getByLabel('What is the event?').fill('Clash'); await page.getByLabel('Booked by').fill('Someone');
await page.getByLabel('From').fill('01:00'); await page.getByLabel('Until').fill('03:00');
await page.getByRole('button', { name: 'Book', exact: true }).click();
await page.getByText(/already booked at that time/).waitFor();
check('overlap refused', true);
await page.getByLabel('New hire').getByRole('button', { name: 'Cancel', exact: true }).click();
await page.getByRole('button', { name: 'Change', exact: true }).click();
await page.getByLabel('Until').fill('03:00');
await page.getByRole('button', { name: 'Save' }).click();
await page.getByText('00:00–03:00 · Board meeting').waitFor();
check('hire time changed', true);
await page.getByRole('button', { name: 'Hire done — put on the bill' }).click();
await page.getByText('Done', { exact: true }).waitFor();
check('hire completed and charged', await page.getByText(/PKR 15,000/).count() > 0);
check('invoice can be issued from the hire', await page.getByRole('button', { name: 'Issue tax invoice' }).count() + await page.getByRole('button', { name: /^Issue/ }).count() > 0);
await page.getByRole('button', { name: /^Issue/ }).first().click();
await page.getByRole('link', { name: /Print.*INV-/ }).waitFor();
check('invoice shows with a print link', true);
await page.screenshot({ path: `${OUT}/21-hire-done.png` });

// 3c. rates: the owner sets a weekend price, an extra-adult price and how many people a type sleeps; they are still there after a reload
await page.locator('nav.tabs button', { hasText: /^Rates$/ }).click();
await page.getByText('Price per night').first().waitFor();
const first = page.locator('li.card', { hasText: 'Standard Room' });
await first.getByLabel('Weekend price').fill('15000');
await first.getByLabel('Extra adult').fill('3000');
await first.getByLabel('Most people').fill('4');
await page.getByRole('button', { name: 'Save prices' }).click();
await page.waitForTimeout(800);
await page.reload(); await page.locator('nav.tabs').waitFor();
await page.locator('nav.tabs button', { hasText: /^Rates$/ }).click();
const again = page.locator('li.card', { hasText: 'Standard Room' });
await again.getByLabel('Weekend price').waitFor();
check('weekend price kept', (await again.getByLabel('Weekend price').inputValue()) === '15000.00');
check('extra adult kept', (await again.getByLabel('Extra adult').inputValue()) === '3000.00');
check('room sleeps 4', (await again.getByLabel('Most people').inputValue()) === '4');
await page.getByRole('button', { name: 'Sat' }).click(); await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/25-rates.png` });

// 3e. money: the owner's bank accounts (personal ones flagged) and the cash safe
await page.locator('nav.tabs button', { hasText: /^Accounts$/ }).click();
await page.getByText('Faysal Bank — Farooq Saleh (Creek)').waitFor();
check('bank accounts are recorded, personal ones flagged', await page.getByText('Bank Al Habib — Sunset BNB (company)').count() > 0);
await page.screenshot({ path: `${OUT}/27-accounts.png` });
await page.locator('nav.tabs button', { hasText: /^Cashier$/ }).click();
await page.getByText('Safe (cash waiting for head office)').waitFor();
check('cash safe shown to the owner', true);

// 3d. rooms: correct a room number and see it in the list
await page.locator('nav.tabs button', { hasText: /^Rooms$/ }).click();
await page.getByRole('heading', { name: 'Floor 1' }).waitFor();
await page.locator('li.card', { hasText: '205' }).getByRole('button', { name: 'Edit' }).click();
await page.getByLabel('Room number').fill('206');
await page.getByRole('button', { name: 'Save', exact: true }).click();
await page.locator('li.card', { hasText: '206' }).waitFor();
check('room renumbered', await page.locator('li.card', { hasText: '205' }).count() === 0);
await page.getByRole('button', { name: 'Add a room' }).click();
await page.getByLabel('Room number').fill('301');
await page.getByRole('button', { name: 'Save', exact: true }).click();
await page.locator('li.card', { hasText: '301' }).waitFor();
check('room added', true);
await page.screenshot({ path: `${OUT}/26-rooms.png` });

// 3b. tax: the owner's matrix is there as drafts waiting for approval
await page.locator('nav.tabs button', { hasText: /^Tax$/ }).click();
await page.getByText('SRB-ST15', { exact: false }).first().waitFor();
check('tax matrix is listed (drafts)', await page.getByText('ICT-ST5D').count() > 0);
await page.screenshot({ path: `${OUT}/24-tax-drafts.png` });

// 3a. setup check: the owner sees what is still missing
await page.locator('nav.tabs button', { hasText: /^Setup check$/ }).click();
await page.getByText(/to do · .* to look at/).waitFor();
check('setup check lists what is missing', await page.getByText('Approved tax rate in force for this property').count() > 0 && await page.getByText('To do', { exact: true }).count() > 0);
await page.screenshot({ path: `${OUT}/23-setup-check.png` });

// 3. kitchen: the menu tab for a manager
await page.locator('nav.tabs button', { hasText: /^Kitchen$/ }).click();
await page.getByRole('button', { name: 'Menu', exact: true }).click();
await page.getByLabel('Section').fill('Mains'); await page.getByLabel('Name', { exact: true }).fill('Karahi'); await page.getByLabel('Price').fill('1800');
await page.getByRole('button', { name: 'Add to menu' }).click();
await page.getByText('Mains · Karahi').waitFor();
check('menu item added', true);

// 4. on a phone the owner's many tabs are grouped: a section picker above, only that section's tabs in the bottom bar
{
  const pctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const ph = await pctx.newPage();
  ph.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
  await ph.goto(BASE);
  await ph.getByLabel(/Company code|کمپنی کوڈ/).fill('sunset'); await ph.getByLabel(/Email|ای میل/).fill('owner@sunset.local'); await ph.getByLabel(/Password|پاس ورڈ/).fill('sunset-demo-passphrase');
  await ph.locator('form button.primary').click(); await ph.locator('nav.tabs').waitFor();
  const visible = async () => (await ph.locator('nav.tabs button:visible').allTextContents());
  check('a section picker is shown', await ph.locator('select.groupsel').isVisible());
  const front = await visible(); check('the bar shows only the section’s tabs', front.length > 0 && front.length <= 6 && !front.includes('Reports'));
  await ph.locator('select.groupsel').selectOption({ label: 'Money' });
  const money = await visible(); check('switching section changes the bar', money.includes('Reports') && money.includes('Cashier') && !money.includes('Rack'));
  await ph.screenshot({ path: `${OUT}/22-phone-money.png` });
}

await browser.close();
console.log(fail.length ? `\n${fail.length} FAILED` : '\nALL PASSED');
process.exit(fail.length ? 1 : 0);
