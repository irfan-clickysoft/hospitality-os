// Browser test: lost & found from the housekeeper's phone to the hand-back.
import { chromium } from 'playwright';
import { session, BASE } from './lib.mjs';

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const fail = [];
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail.push(name); };
const stamp = Date.now().toString().slice(-6);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 9)]);

const hira = await session('hira@sunset.local');
const pid = (await hira.get('/v1/me/properties')).items.find((p) => p.name.endsWith('Boulevard')).id;
const types = (await hira.get(`/v1/properties/${pid}/rack?days=1`)).roomTypes;
await hira.post(`/v1/properties/${pid}/front-desk/walk-ins`, { guest: { fullName: `Zubair Lost ${stamp}`, phone: `0333${stamp}1`, nationality: 'PK' }, roomTypeId: types.find((x) => x.availability[0].available > 0).id, nights: 1, adults: 1,
  occupants: [{ fullName: `Zubair Lost ${stamp}`, isPrimary: true, idType: 'CNIC', idNumber: '35202-1234567-1', nationality: 'PK' }] }, { 'idempotency-key': `lf-e2e-${stamp}-0001` });

async function login(email, width = 1280) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fail.push('pageerror ' + e.message); });
  await page.goto(BASE);
  await page.getByLabel(/Company code/).fill('sunset'); await page.getByLabel(/^Email/).fill(email); await page.getByLabel(/^Password/).fill(process.env.E2E_PASSWORD ?? 'sunset-demo-passphrase');
  await page.locator('form button.primary').click(); await page.getByRole('navigation').first().waitFor();
  await page.evaluate(() => { window.location.hash = '/housekeeping?tab=lost'; });
  return page;
}
const sheet = (p) => p.locator('.sheet').last();

const sana = await login('sana@sunset.local');
await sana.getByRole('button', { name: 'Add a found item' }).click();
await sheet(sana).locator('input[type=file]').setInputFiles({ name: 'wallet.png', mimeType: 'image/png', buffer: PNG });
await sheet(sana).getByLabel('What was found?').fill(`Black wallet ${stamp}`);
await sheet(sana).locator('select').first().selectOption('DOCUMENT');
await sheet(sana).getByLabel('Kept at').fill('Front desk safe');
await sheet(sana).getByRole('button', { name: 'Save item' }).click();
const row = sana.locator('li', { hasText: `Black wallet ${stamp}` });
await row.waitFor();
check('the item is listed with its reference, place kept and a picture', (await row.innerText()).includes('Front desk safe') && /LF-[A-Z]+-\d\d-\d{5}/.test(await row.innerText()) && (await row.locator('img.lf-thumb').count()) === 1);

await row.click();
await sheet(sana).getByRole('button', { name: 'Link the guest' }).click();
await sheet(sana).getByLabel('Find the guest').fill('Zubair Lost');
await sheet(sana).getByRole('button', { name: new RegExp(`Zubair Lost ${stamp}`) }).click();
await sheet(sana).getByText(`May belong to`).waitFor();
check('the guest is linked as the possible owner', (await sheet(sana).innerText()).includes(`Zubair Lost ${stamp}`));
await sheet(sana).getByRole('button', { name: 'Tell the guest' }).click();
const msg = await sheet(sana).locator('textarea').inputValue();
check('the message names the item and the reference but not the private description', msg.startsWith(`Dear Zubair Lost ${stamp},`) && msg.includes(`Black wallet ${stamp}`) && /Reference: LF-/.test(msg));
check('it opens WhatsApp on the guest’s number', (await sheet(sana).getByRole('link', { name: /Send on WhatsApp/ }).getAttribute('href'))?.startsWith('https://wa.me/92333') === true);

// the property admin hands it back
const adm = await login('manager@sunset.local');
await adm.locator('li', { hasText: `Black wallet ${stamp}` }).click();
await sheet(adm).getByRole('button', { name: 'Hand back' }).click();
await sheet(adm).getByLabel('Name of the person receiving it').fill(`Zubair Lost ${stamp}`);
await sheet(adm).getByLabel('ID they showed').fill('CNIC ending 5671');
await sheet(adm).getByLabel('How you made sure it is theirs').fill('Described the cards inside');
await sheet(adm).getByRole('button', { name: 'Confirm hand-over' }).click();
await sheet(adm).getByText(/Handed to/).waitFor();
check('the hand-over is recorded with who took it and how it was verified', (await sheet(adm).innerText()).includes('CNIC ending 5671') && (await sheet(adm).innerText()).includes('Described the cards inside'));
await adm.keyboard.press('Escape');
await adm.getByRole('button', { name: 'Returned' }).click();
const moved = await adm.locator('li', { hasText: `Black wallet ${stamp}` }).waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
check('it moves to the returned list', moved);
await browser.close();
if (fail.length) { console.log('\nFAILED:', fail.join('; ')); process.exit(1); }
console.log('\nALL PASSED');
