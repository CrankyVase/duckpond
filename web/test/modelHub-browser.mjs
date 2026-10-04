// Safe browser check for the Installed → chat path. All API responses are
// mocked; no model is loaded or registered on the real machine.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url = process.env.PREVIEW_URL || 'http://127.0.0.1:5198';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let registered = false;
let patchedModel = null;
const repoId = 'unsloth/Example-8B-GGUF';
const alias = 'example-8b-q4-k-m';
const conv = { id: 42, title: 'Test chat', mode: 'chat', model_id: 'starter', settings: { ctx_size: 32768 }, messages: [], active_leaf_id: null };
const local = [
  { source: 'hf-cache', repoId, kind: 'gguf', task: 'chat', repoDir: '/ssd/cache/example', totalBytes: 5e9,
    updatedAt: new Date().toISOString(), variants: [{ name: 'Example-8B-Q4_K_M.gguf', include: 'Example-8B-Q4_K_M.gguf', size: 5e9, quant: 'Q4_K_M', chatCompatible: true }] },
  { source: 'media-components', repoId: 'MiniMaxAI/MiniMax-H3', label: 'MiniMaxAI/MiniMax-H3', kind: 'components', task: 'video',
    repoDir: '/ssd/comfy/models', totalBytes: 70e9, updatedAt: new Date().toISOString(),
    variants: [{ name: 'diffusion_models/minimax_h3.safetensors', include: null, size: 70e9 }] },
];
await page.route('**/*', async (route) => {
  const req = route.request();
  const path = new URL(req.url()).pathname;
  if (!path.startsWith('/api/')) return route.continue();
  let body = {};
  if (path === '/api/auth/me') body = { id: 1, username: 'owner', role: 'owner' };
  else if (path === '/api/models') body = [
    { id: 'starter', status: 'unloaded', kind: 'chat', caps: { tools: true } },
    ...(registered ? [{ id: alias, status: 'unloaded', kind: 'chat', caps: { tools: true } }] : []),
  ];
  else if (path === '/api/conversations') body = [conv];
  else if (path === '/api/conversations/42') {
    if (req.method() === 'PATCH') {
      patchedModel = req.postDataJSON().model_id;
      conv.model_id = patchedModel;
      body = { ok: true };
    } else body = conv;
  } else if (path === '/api/conversations/42/live') return route.fulfill({ status: 204 });
  else if (path === '/api/conversations/42/context') body = { used: 0, budget: 32768 };
  else if (path === '/api/hf/local') body = { models: local, totalBytes: 75e9 };
  else if (path === '/api/hf/hardware') body = { gpuLabel: '16 GB', ramLabel: '64 GB' };
  else if (path === '/api/hf/downloads') body = { jobs: [] };
  else if (path === '/api/hf/recommend') body = { models: [] };
  else if (path === '/api/hf/search') body = { models: [{ id: repoId, kind: 'chat', downloads: 120000 }], nextCursor: null };
  else if (path.startsWith('/api/hf/quantizers/')) body = [];
  else if (path.startsWith('/api/hf/variants/')) body = { variants: [{ name: 'Example-8B-Q4_K_M.gguf', include: 'Example-8B-Q4_K_M.gguf', quant: 'Q4_K_M', size: 5e9, fit: 'fits', downloaded: true }], total: 5e9, recommended: 'Example-8B-Q4_K_M.gguf', vramFreeBytes: 12e9 };
  else if (path.startsWith('/api/hf/readme/')) body = { text: '' };
  else if (path === '/api/hf/register') {
    assert.deepEqual(req.postDataJSON(), { source: 'hf-cache', repoId, include: 'Example-8B-Q4_K_M.gguf', load: false });
    registered = true;
    body = { ok: true, alias };
  } else if (path === '/api/images/models') body = { available: true, models: [{ id: 'MiniMaxAI/MiniMax-H3', task: 'video', ready: true }] };
  else if (path === '/api/images') body = [];
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
});
try {
  await page.goto(`${url}/u/1/hub`);
  await page.getByRole('heading', { name: 'Model Hub' }).waitFor();
  await page.getByText(repoId, { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Use in chat' }).count(), 1);
  await page.getByRole('button', { name: 'Discover' }).click();
  await page.locator('.split .list .rrow').first().waitFor();
  assert.equal(await page.locator('.split .detail').isVisible(), false, 'phone opens to results');
  await page.locator('.split .list .rrow').first().click();
  assert.equal(await page.locator('.split .detail').isVisible(), true, 'selection opens model details');
  assert.equal(await page.locator('.split .list').isVisible(), false, 'results step yields to details on phone');
  await page.getByRole('button', { name: 'Browse results' }).click();
  assert.equal(await page.locator('.split .list').isVisible(), true, 'back action returns to results');
  await page.getByRole('button', { name: 'Installed' }).click();
  await page.getByRole('button', { name: 'Use in chat' }).waitFor();
  await page.getByRole('button', { name: 'Use in chat' }).click();
  await page.getByTitle('Switch model (Ctrl+K)').getByText(alias, { exact: true }).waitFor();
  assert.equal(await page.locator('header .modeswitch button').count(), 2);
  assert.equal(await page.getByRole('button', { name: /Pet Dumpling the duck/i }).count(), 1);
  const duck = await page.getByRole('button', { name: /Pet Dumpling the duck/i }).boundingBox();
  assert(duck && duck.width >= 60, 'the welcome mascot is visible and large enough to pet');
  await page.screenshot({ path: '/tmp/duckpond-chat-welcome-390.png' });
  assert.equal(patchedModel, alias);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log('Installed GGUF registers, selects in chat, and media components stay out of the picker.');
} finally {
  await browser.close();
}
