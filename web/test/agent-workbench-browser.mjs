// UI contract tests use mock API data; real project execution is covered server-side.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.PREVIEW_URL || 'http://127.0.0.1:5198';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') console.error(m.text()); });
const conversations = [
  { id: 42, mode: 'agent', workspace_id: 1, title: 'Portfolio refresh', model_id: 'test-model', settings: {}, messages: [], updated_at: Date.now()/1000 },
  { id: 43, mode: 'chat', title: 'Everyday chat', model_id: 'test-model', settings: {}, messages: [], updated_at: Date.now()/1000 },
];
const projects = [{ id: 1, name: 'Portfolio', host_path: '/home/cranky/my-website' }];
await page.route('**/api/**', async route => {
  const req = route.request(), u = new URL(req.url());
  let body = {};
  const conv = u.pathname.match(/^\/api\/conversations\/(\d+)$/);
  if (u.pathname.endsWith('/live')) return route.fulfill({ status: 204 });
  if (conv) {
    body = conversations.find(c => c.id === Number(conv[1]));
    if (req.method() === 'PATCH') Object.assign(body, req.postDataJSON());
  } else if (u.pathname === '/api/auth/me') body = { id: 1, username: 'cranky', role: 'owner' };
  else if (['/api/tools','/api/memories','/api/auth/users','/api/auth/invites','/api/admin/bans'].includes(u.pathname)) body = [];
  else if (u.pathname === '/api/conversations') body = conversations;
  else if (u.pathname === '/api/models') body = [{ id: 'test-model', status: 'loaded', ctxSize: 32768, settings: {}, caps: { tools: true } }];
  else if (u.pathname === '/api/workspaces') body = projects;
  else if (u.pathname.endsWith('/files')) body = { files: [{ path: 'index.html' }, { path: 'src/App.svelte' }, { path: 'package.json' }] };
  else if (u.pathname.endsWith('/file')) body = { content: `Source for ${u.searchParams.get('path')}\nexport const title = 'Portfolio';` };
  else if (u.pathname.endsWith('/server')) body = { running: true, base: '/api/project-runtime/qa/', logs: 'Listening on port 3000' };
  else if (u.pathname.endsWith('/preview-session')) body = { base: '/api/workspace-preview/qa/' };
  else if (u.pathname.startsWith('/api/workspace-preview/')) return route.fulfill({ contentType: 'text/html', body: '<h1>Static portfolio</h1>' });
  else if (u.pathname.startsWith('/api/project-runtime/')) return route.fulfill({ contentType: 'text/html', body: '<h1>Live portfolio</h1>' });
  else if (u.pathname.endsWith('/context')) body = { used: 100, budget: 32768 };
  else if (u.pathname === '/api/runs/7/changes') body = { files:[{path:'src/App.svelte',before:'Old introduction',after:'New introduction',created:false,edits:1}],scope:'Recorded file-tool edits only.' };
  else if (u.pathname === '/api/runs/7/events') return route.fulfill({contentType:'text/event-stream',body:[
    {id:1,type:'tool_call',name:'search_files',args:{query:'navigation'}},
    {id:2,type:'tool_result',name:'search_files',result:'src/App.svelte:12 navigation'},
    {id:3,type:'tool_result',name:'edit_file',result:'ERROR: search string not found. No changes were applied.'},
    {type:'run',run:{status:'done'}}
  ].map(e=>`data: ${JSON.stringify(e)}\n\n`).join('')});
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
});
try {
  await page.goto(`${origin}/u/1/portfolio-refresh+42`);
  await page.getByRole('heading', { name: 'What do you want to build?' }).waitFor();
  const panel = page.getByRole('complementary', { name: 'Project workbench' });
  await page.frameLocator('iframe[title="Project preview"]').getByText('Static portfolio').waitFor();
  const width = (await panel.boundingBox()).width;
  await page.getByRole('button', { name: /^Files 3$/ }).click();
  assert.equal((await panel.boundingBox()).width, width, 'Switching tabs keeps pane width stable');
  await page.getByRole('searchbox', { name: 'Filter project files' }).fill('App');
  assert.equal(await page.locator('.tree .rowwrap').count(), 1);
  await page.locator('.tree .row').click();
  await panel.getByText("export const title = 'Portfolio';", { exact: false }).waitFor();
  assert.equal(await page.locator('.overlay').count(), 0, 'Source stays inside the workbench');
  await page.getByRole('button', { name: 'Resize project pane' }).press('ArrowLeft');
  assert((await panel.boundingBox()).width > width);
  await page.getByRole('button', { name: 'Live app', exact: true }).click();
  await page.frameLocator('iframe[title="Project preview"]').getByText('Live portfolio').waitFor();
  await page.getByTitle('Reload preview').click();
  await page.frameLocator('iframe[title="Project preview"]').getByText('Live portfolio').waitFor();
  await page.getByRole('button', { name: 'Logs', exact: true }).click();
  await page.getByText('Listening on port 3000').waitFor();
  await page.screenshot({ path: '/tmp/duckpond-agent-workbench-desktop.png' });
  const before = await page.locator('.chat').boundingBox();
  await page.getByRole('button', { name: 'Project setup', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  assert.deepEqual(await page.locator('.chat').boundingBox(), before, 'Project setup must not displace conversation');
  await page.getByLabel('Instructions for this agent conversation').fill('Run tests before finishing.');
  await page.getByRole('button', { name: 'Save instructions' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(conversations[0].settings.system_prompt, 'Run tests before finishing.');
  await page.locator('.composer textarea').fill('Agent draft stays with my project');
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await panel.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.composer textarea').inputValue(), '');
  await page.locator('.composer textarea').fill('Chat draft is separate');
  assert.equal(conversations[1].settings.system_prompt, undefined);
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await panel.waitFor();
  assert.equal(await page.locator('.composer textarea').inputValue(), 'Agent draft stays with my project');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-main').waitFor();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await panel.waitFor();
  assert.equal(await page.locator('.composer textarea').inputValue(), 'Agent draft stays with my project');
  conversations[0].messages = [{ id: 1, role: 'assistant', content: 'I found the project files.', run_id: 7 }];
  conversations[0].active_leaf_id = 1;
  await page.reload();
  await page.getByText('ERROR: search string not found. No changes were applied.').waitFor();
  assert.equal(await page.locator('.composer textarea').inputValue(), 'Agent draft stays with my project');
  await page.getByRole('button', {name:/^Changes 1$/}).click();
  await page.getByText('Latest task changes', {exact:true}).waitFor();
  await page.getByText('New introduction', {exact:true}).waitFor();
  await page.getByRole('button', {name:'Current source',exact:true}).click();
  await panel.getByText("export const title = 'Portfolio';", {exact:false}).waitFor();
  await page.locator('.result').first().locator('summary').click();
  await page.getByText('src/App.svelte:12 navigation', { exact: true }).waitFor();
  await page.screenshot({ path: '/tmp/duckpond-agent-activity-desktop.png' });
  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.reload();
    await page.getByTitle('Show project files').click();
    await panel.waitFor();
    const box = await panel.boundingBox();
    assert(box.width <= width && box.x >= 0);
    await page.getByRole('button', { name: 'Live app', exact: true }).click();
    await page.frameLocator('iframe[title="Project preview"]').getByText('Live portfolio').waitFor();
    await page.screenshot({ path: `/tmp/duckpond-agent-workbench-${width}.png` });
    await page.getByTitle('Hide files').click();
    await page.getByRole('button', { name: 'Project setup', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  assert.deepEqual(errors, []);
  console.log('Agent workbench passed: stable/resizable panes, inline source, filtering, live reload/logs, modal setup, separate modes/instructions, visible tool failures and results, desktop/tablet/phone.');
} catch (error) {
  console.error('Browser errors:', errors);
  await page.screenshot({ path:'/tmp/duckpond-workbench-failure.png' });
  throw error;
} finally { await browser.close(); }
