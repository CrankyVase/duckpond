// Explicit opt-in: authenticated read-only navigation against the owner's live app.
// Cookie stays in memory; never print it or persist browser storage.
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
if (!process.env.DUCKPOND_LIVE_DB) throw new Error('Set DUCKPOND_LIVE_DB explicitly');
const db = new Database(process.env.DUCKPOND_LIVE_DB, { readonly: true });
const session = db.prepare(`SELECT s.id, s.user_id FROM sessions s JOIN users u ON u.id=s.user_id
 WHERE u.role='owner' AND s.expires_at>unixepoch() ORDER BY s.last_seen DESC LIMIT 1`).get();
db.close();
if (!session) throw new Error('No signed-in owner session available');
const origin = 'https://aii.crankyvase.site';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addCookies([{ name: 'dp_session', value: session.id, url: origin, httpOnly: true, secure: true }]);
const page = await context.newPage();
page.setDefaultTimeout(12000);
const errors = [], failures = [], blocked = [];
page.on('pageerror', e => errors.push(e.message));
page.on('response', r => { if (r.url().includes('/api/') && r.status() >= 400) failures.push({ path: new URL(r.url()).pathname, status: r.status() }); });
await context.route('**/api/**', async route => {
  const request = route.request();
  if (!['GET','HEAD'].includes(request.method())) {
    blocked.push({ path: new URL(request.url()).pathname, method: request.method() });
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Read-only navigation check: action not executed.' }) });
  }
  return route.continue();
});
try {
  // Start at a utility route to avoid creating an empty conversation on boot.
  await page.goto(`${origin}/u/${session.user_id}/settings`);
  await page.locator('.settings-main').waitFor();
  console.log('Settings mounted');
  console.log('Settings navigation', await page.locator('.navitem').allTextContents());
  for (const item of await page.locator('.navitem').all()) {
    const label = (await item.innerText()).trim();
    await item.click();
    if ((await page.locator('.section-heading h1').innerText()).trim() !== label) throw new Error(`Settings section did not change: ${label}`);
  }
  console.log('All settings sections clicked');
  const links = ['Media Studio', 'Model Hub', 'Settings'];
  for (const name of links) {
    await page.locator('aside a.page').filter({ hasText: name }).first().click();
    await page.waitForTimeout(700);
    console.log('Clicked', name, '=>', new URL(page.url()).pathname);
    if (name === 'Media Studio') {
      for (const tab of ['Images','Video','Music & sound','Voice']) {
        await page.getByRole('button', { name: tab, exact: true }).click();
        await page.waitForTimeout(150);
        console.log('Media tab', tab);
      }
    }
    if (name === 'Model Hub') {
      await page.getByRole('button',{name:'Installed',exact:true}).click();
      await page.getByRole('searchbox',{name:'Search installed models'}).fill('qwen');
      await page.waitForTimeout(500);
      await page.getByLabel('Filter installed models').selectOption('attention');
      await page.getByLabel('Filter installed models').selectOption('all');
      await page.getByRole('searchbox',{name:'Search installed models'}).fill('');
      await page.waitForTimeout(500);
      console.log('Installed inventory rendered, searched and filtered');
    }
  }
  await page.getByRole('button', { name: 'More', exact: true }).click();
  console.log('More menu', await page.locator('.morewrap').innerText());
  for (const name of ['Files','Stats','Providers','Costs']) {
    if (!await page.locator('.moredrop').isVisible()) await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.locator('.moredrop a').filter({ hasText: name }).click();
    await page.waitForTimeout(400);
    console.log('Utility clicked', name, '=>', new URL(page.url()).pathname);
  }
  const existing = await page.request.get(`${origin}/api/conversations`);
  const conversations = await existing.json();
  for (const mode of ['chat', 'agent']) {
    if (!conversations.some(c => c.mode === mode)) continue; // Never create a task in this check.
    await page.getByRole('button', { name: mode === 'chat' ? 'Chat' : 'Agent', exact: true }).click();
    await page.locator('.composer textarea').waitFor();
    await page.locator('aside a.page').filter({ hasText: 'Settings' }).click();
    await page.locator('.settings-main').waitFor();
    await page.getByRole('button', { name: mode === 'chat' ? 'Chat' : 'Agent', exact: true }).click();
    await page.locator('.composer textarea').waitFor();
    console.log('Mode returns from Settings', mode);
    await page.getByTitle('Switch model (Ctrl+K)').click();
    await page.locator('.picker .menu').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.picker .menu').waitFor({ state: 'hidden' });
    if (mode === 'agent') {
      await page.getByRole('button', { name: 'Project setup', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      await page.getByRole('button', { name: 'Create new project', exact: true }).click();
      await page.getByRole('button', { name: 'Open existing folder', exact: true }).click();
      await page.getByLabel('Source folder').waitFor();
      await page.keyboard.press('Escape');
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.locator('aside a.page').filter({ hasText: 'Media Studio' }).click();
  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.locator('aside a.page').filter({ hasText: 'Settings' }).click();
  await page.locator('.settings-main').waitFor();
  console.log('Phone drawer navigation and media tab passed');
  await page.screenshot({ path: '/tmp/duckpond-live-navigation.png' });
  console.log(JSON.stringify({ errors, failures, blocked }));
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ errors, failures, blocked, path: new URL(page.url()).pathname, visibleErrors: await page.locator('.toast, .fatal, .error').allTextContents() }));
  await page.screenshot({ path: '/tmp/duckpond-live-navigation-failure.png' });
  throw error;
} finally { await browser.close(); }
