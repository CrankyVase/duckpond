// Run against Vite preview. All API requests are mocked; never loads a model.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const previewUrl = process.env.PREVIEW_URL || 'http://127.0.0.1:5198';
import assert from 'node:assert/strict';
const browser = await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE || undefined,args:['--no-sandbox']});
const context = await browser.newContext({ viewport:{width:1440,height:1000},deviceScaleFactor:1 });
const page = await context.newPage();
const errors=[], external=[], posts=[];
let outcome='done';
const conversation = {id:42,title:'Recovery test',model_id:'test',settings:{ctx_size:32768},active_leaf_id:4,
  messages:[
    {id:1,parent_id:null,role:'user',content:'History stays here'},
    {id:2,parent_id:1,role:'assistant',content:'Original failed-message text',search:{steps:[{}]}},
    {id:3,parent_id:2,role:'assistant',content:'```html\n<html><body>Preview<script>try { parent.document.body.dataset.previewTouched="yes"; } catch { document.body.append(" isolated"); }</script></body></html>\n```'},
    {id:4,parent_id:3,role:'user',content:'Later history stays too'},
  ]};
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',async route=>{
  const request=route.request(), u=new URL(request.url());
  if(u.origin!==new URL(previewUrl).origin) {external.push(u.hostname);return route.abort();}
  if(!u.pathname.startsWith('/api/')) return route.continue();
  let body={};
  const models=[{id:'stabilityai/stable-diffusion-xl-base-1.0',task:'image',ready:true,kind:'diffusers'},{id:'openmoss-team/moss-tts-nano-100m',task:'tts',ready:true,kind:'native_audio',cloning:false},{id:'k2-fsa/OmniVoice',task:'tts',ready:false,kind:'omnivoice',cloning:true,reason:'Install the OmniVoice runtime to use this model'},{id:'facebook/musicgen-small',task:'audio',ready:true,kind:'musicgen',maxDuration:30}];
  if(u.pathname==='/api/conversations/42/live') return route.fulfill({status:204});
  else if(u.pathname==='/api/conversations/42') body=conversation;
  else if(u.pathname==='/api/conversations/42/context') body={used:3400,budget:32768,estimated:true};
  else if(u.pathname==='/api/auth/me') body={id:1,username:'cranky',role:'owner'};
  else if(u.pathname==='/api/models'||u.pathname==='/api/conversations') body=[];
  else if(u.pathname==='/api/images/models') body={available:true,models};
  else if(u.pathname==='/api/images') body=[];
  else if(u.pathname==='/api/hf/local') body={models:[],totalBytes:0};
  else if(u.pathname==='/api/hf/hardware') body={gpuLabel:'16 GB',ramLabel:'64 GB'};
  else if(u.pathname==='/api/hf/downloads') body={jobs:[]};
  else if(u.pathname.startsWith('/api/hf/search')||u.pathname.startsWith('/api/hf/modality')||u.pathname==='/api/hf/recommend') body={models:[{id:'unsloth/Qwen3-8B-GGUF',kind:'chat',pipelineTag:'text-generation',downloads:124800,likes:842,gguf:true},{id:'unsloth/gemma-3-4b-it-GGUF',kind:'chat',pipelineTag:'image-text-to-text',downloads:98200,likes:465,gguf:true},{id:'unsloth/DeepSeek-R1-8B-GGUF',kind:'chat',pipelineTag:'text-generation',downloads:68400,likes:234,gguf:true}]};
  else if(u.pathname.startsWith('/api/hf/quantizers')) body={quantizers:[],models:[]};
  else if(u.pathname.startsWith('/api/hf/variants')) body={kind:'gguf',variants:[{name:'Q4_K_M.gguf',include:'Q4_K_M.gguf',size:5e9,fit:'fits',quant:'Q4_K_M',tps:45}],pick:'Q4_K_M.gguf',total:5e9};
  else if(u.pathname.startsWith('/api/hf/readme')) body={text:'# A model for your everyday ideas\n\nA capable model for writing, reasoning, and exploring.\n\n![remote](https://blocked.test/tracker.png)\n\n<img src="https://blocked.test/tracker2.png">'};
  else if(u.pathname==='/api/version') body={version:'0.4.0',commit:'preview'};
  else if(u.pathname==='/api/images/generate') {
    posts.push(request.postDataJSON());
    if(outcome==='slow') {await new Promise(r=>setTimeout(r,1500));return route.fulfill({contentType:'text/event-stream',body:'data: {"type":"error","message":"cancelled"}\n\n'}).catch(()=>{});}
    const result=outcome==='error'?{type:'error',message:'Model component is missing. Complete its download and retry.'}:{type:'done',images:[{id:1,url:'/api/images/1/file',task:posts.at(-1).task}],model_used:posts.at(-1).model};
    return route.fulfill({contentType:'text/event-stream',body:`data: ${JSON.stringify(result)}\n\n`});
  } else if(u.pathname==='/api/images/1/file') return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1sAAAAASUVORK5CYII=','base64')});
  return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
});
await page.goto(`${previewUrl}/u/1/media`);
await page.getByRole('heading',{name:'Media Studio.'}).waitFor();
await page.getByRole('button',{name:'Start with an idea'}).click();
await page.screenshot({path:'/tmp/duckpond-media-desktop.png',fullPage:true});
await page.getByRole('button',{name:'Voice',exact:true}).click();
assert.equal(await page.locator('.controls select').inputValue(),'auto');
assert(await page.locator('.controls select').textContent().then(s=>s.includes('moss-tts')));
assert(!await page.locator('.controls select').textContent().then(s=>s.includes('stable-diffusion')));
await page.getByRole('button',{name:'Start with an idea'}).click();
await page.locator('.generate').click();
await page.locator('.creation').waitFor();
assert.equal(posts.at(-1).task,'tts');
assert.equal(posts.at(-1).model,'openmoss-team/moss-tts-nano-100m');
await page.getByRole('button',{name:'Images',exact:true}).click();
await page.getByRole('button',{name:'Start with an idea'}).click();
outcome='error';await page.locator('.generate').click();
await page.getByRole('alert').filter({hasText:'Model component is missing'}).waitFor();
outcome='slow';await page.locator('.generate').click();
await page.getByRole('button',{name:'Stop generation',exact:true}).click();
await page.locator('.generate').waitFor();
await page.getByRole('button',{name:'Video',exact:true}).click();
assert(await page.locator('.generate').isDisabled());
await page.setViewportSize({width:390,height:844});
await page.goto(`${previewUrl}/u/1/media`);
await page.getByRole('heading',{name:'Media Studio.'}).waitFor();
await page.waitForTimeout(350);
await page.screenshot({path:'/tmp/duckpond-media-mobile.png',fullPage:true});
assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
await page.setViewportSize({width:1440,height:1000});
await page.goto(`${previewUrl}/u/1/hub`);
await page.getByRole('heading',{name:'Model Hub.'}).waitFor();
await page.waitForTimeout(500);
await page.screenshot({path:'/tmp/duckpond-hub-desktop.png',fullPage:true});
await page.goto(`${previewUrl}/u/1/recovery-test+42`);
await page.getByText('History stays here',{exact:true}).waitFor();
await page.getByText('Later history stays too',{exact:true}).waitFor();
await page.locator('.message-fallback').waitFor();
assert((await page.locator('.message-fallback').innerText()).includes('Original failed-message text'));
await page.getByRole('button',{name:'Retry display',exact:true}).click();
await page.getByText('Later history stays too',{exact:true}).waitFor();
await page.getByRole('button',{name:'preview',exact:true}).click();
await page.frameLocator('.html-preview-frame').getByText('Preview isolated',{exact:true}).waitFor();
assert.equal(await page.evaluate(()=>document.body.dataset.previewTouched),undefined);
await page.getByRole('button',{name:'close',exact:true}).click();
await page.getByText('History stays here',{exact:true}).waitFor();
assert.deepEqual(external,[]);
assert.deepEqual(errors,[]);
console.log('Browser checks passed: desktop/mobile layouts, task-specific models, mock voice generation, visible failure, Stop, missing-model disable, message-error isolation, sandboxed inline HTML preview, no external requests or page errors.');
await browser.close();
