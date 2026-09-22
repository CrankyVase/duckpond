import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ args:['--no-sandbox'] });
const page = await browser.newPage({viewport:{width:390,height:844}});
let loaded = true, conflict = true, calls = 0;
await page.route('**/api/**', async route => {
  const path = new URL(route.request().url()).pathname;
  let body = [];
  if (path === '/api/auth/me') body = {id:1,username:'owner',role:'owner'};
  else if (path === '/api/images/models') body = {available:true,default_model:'Qwen/Qwen-Image-2.1',models:[{id:'Qwen/Qwen-Image-2.1',task:'image',kind:'diffusers',ready:true,loaded,device:'cpu',defaultSteps:40}]};
  else if (path === '/api/images/unload') {
    calls++;
    assert.equal(route.request().postDataJSON().model,'Qwen/Qwen-Image-2.1');
    if(conflict) return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Generation is active. Stop it and wait for it to finish before unloading.'})});
    loaded = false; body = {ok:true};
  } else if (path === '/api/media/jobs') body = {jobs:[],paused:false};
  return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
});
try {
  await page.goto((process.env.PREVIEW_URL || 'http://127.0.0.1:5199')+'/u/1/media');
  await page.getByText('CPU · system RAM · Loaded',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Unload model',exact:true}).click();
  await page.getByText(/Generation is active/).waitFor();
  conflict = false;
  await page.getByRole('button',{name:'Unload model',exact:true}).click();
  await page.getByText('CPU · system RAM · Loads when needed',{exact:true}).waitFor();
  assert.equal(calls,2);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:'/tmp/duckpond-media-cpu-mobile.png'});
  console.log('Media UI passed: CPU status, unload conflict, successful unload, mobile width');
} finally { await browser.close(); }
