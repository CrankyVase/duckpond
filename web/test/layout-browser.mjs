// Run against Vite preview. All API requests are mocked; never loads a model.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const previewUrl = process.env.PREVIEW_URL || 'http://127.0.0.1:5198';
import assert from 'node:assert/strict';
const browser = await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE || undefined,args:['--no-sandbox']});
const context = await browser.newContext({ viewport:{width:1440,height:1000},deviceScaleFactor:1 });
const page = await context.newPage();
const errors=[], external=[], posts=[];
let outcome='done';
let downloadJobs=[], downloadPolls=0, projectVersion=1;

const settings={temperature:0.7,top_p:0.9,top_k:40,repeat_penalty:1.1,ctx_size:32768,disabledTools:[],context_saver:'auto',thinking:'auto',system_prompt:''};
const catalog=[{id:'qwen3-8b-q4',status:'unloaded',ctxSize:32768,settings,caps:{tools:true,reasoning:true}},{id:'r1:atlas-large',remote:true,status:'remote',ctxSize:131072,settings,provider:{id:1,name:'Cloud workspace'},pricing:{in:0.2,out:0.6},caps:{tools:true}}];
const provider={id:1,name:'Cloud workspace',kind:'compatible',base_url:'https://api.example.test/v1',enabled:true,models:2,models_on:2,cache_enabled:true,has_key:true,import_mode:'curated',month_spend:2.34,fallback:['atlas-large','atlas-small']};
const providerModels=[{model_id:'atlas-large',label:'Atlas Large',enabled:true,caps:{tools:true},context_length:131072},{model_id:'atlas-small',label:'Atlas Small',enabled:true,caps:{tools:true},context_length:32768}];

const conversation = {id:42,title:'Recovery test',model_id:'qwen3-8b-q4',settings:{ctx_size:32768},active_leaf_id:4,
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
  else if(u.pathname==='/api/models') body=catalog;
  else if(u.pathname==='/api/conversations') body=[];
  else if(u.pathname==='/api/providers') body=[provider];
  else if(u.pathname==='/api/providers/1' && request.method()==='PATCH') {Object.assign(provider,request.postDataJSON());body={provider};}
  else if(u.pathname==='/api/providers/1/models') body={models:providerModels,counts:{on:2,total:2}};
  else if(u.pathname==='/api/providers/presets') body=[{key:'cloud',name:'Example Cloud',blurb:'Connect a hosted model catalog with your own API key.',keyUrl:'#'}];
  else if(u.pathname==='/api/router/health') body={ok:true,latencyMs:12,endpoint:'http://127.0.0.1:8081'};
  else if(u.pathname==='/api/permissions') body={policy:{mode:'balanced'}};
  else if(u.pathname==='/api/tools') body=[{id:'read_file',label:'Read files',category:'Workspace',description:'Read source files and documents in the current project.'},{id:'run_command',label:'Run commands',category:'Workspace',description:'Execute terminal commands in the project workspace.'},{id:'web_search',label:'Search the web',category:'Research',description:'Find useful pages and current information.'}];
  else if(['/api/auth/users','/api/auth/invites','/api/admin/bans','/api/memories'].includes(u.pathname)) body=[];
  else if(u.pathname==='/api/admin/settings') body={core_prompt:'Be useful and precise.',default_core_prompt:'Be useful and precise.'};
  else if(u.pathname==='/api/runs/7/events') return route.fulfill({contentType:'text/event-stream',body:[
    {id:10,type:'tool_call',name:'start_project',args:{name:'snake-game'}},
    {id:11,type:'diff',path:'/workspace/snake-game/index.html',created:true,after:'<!doctype html>\n<html>\n  <body>Snake game</body>\n</html>'},
    {id:12,type:'tool_call',name:'run_command',args:{command:'npm run build'}},
    {id:13,type:'tool_output',command:'npm run build',exitCode:0,output:'Build completed successfully.'},
    {type:'run',run:{status:'done'}}
  ].map(e=>`data: ${JSON.stringify(e)}\n\n`).join('')});
  else if(u.pathname==='/api/files') body={images:[],uploads:[],docs:[{id:1,name:'Project notes.md',size_label:'4 KB',status:'ready'}],exports:[],workspaces:[],quota:{pct:4,used_label:'600 MB',limit_label:'15 GB'}};
  else if(u.pathname==='/api/stats') body={totals:{requests:248,tokens_in:1428000,tokens_out:186000},perModel:[{model_id:'qwen3-8b-q4',requests:248,tokens_in:1428000,tokens_out:186000,avg_tok_s:42.8,rolling_tok_s:45.2}]};
  else if(u.pathname==='/api/costs/summary') body={totals:{events:12,spend:2.34,saved:1.18},month:{spend:2.34,saved:1.18},cache:{n:6,hits:8},byKind:[],byProvider:[],byModel:[]};
  else if(u.pathname==='/api/costs/daily') body=[{day:'2026-09-07',spend:1.2,saved:0.6},{day:'2026-09-08',spend:1.14,saved:0.58}];
  else if(u.pathname==='/api/costs/events') body=[];
  else if(u.pathname==='/api/workspaces') body=[{id:1,name:'Snake game'}];
  else if(u.pathname==='/api/workspaces/1/files') body={files:[{path:'index.html',dir:false},{path:'style.css',dir:false}]};
  else if(u.pathname==='/api/workspaces/1/preview-session') body={base:'/api/workspace-preview/mock/'};
  else if(u.pathname==='/api/workspaces/1/file') body={content:`Source version ${projectVersion}`};
  else if(u.pathname==='/api/workspace-preview/mock/index.html') return route.fulfill({contentType:'text/html',headers:{'cache-control':'no-store'},body:`<h1>Snake preview ${projectVersion}</h1>`});
  else if(u.pathname==='/api/images/models') body={available:true,models};
  else if(u.pathname==='/api/images') body=[];
  else if(u.pathname==='/api/hf/local') body={models:[],totalBytes:0};
  else if(u.pathname==='/api/hf/hardware') body={gpuLabel:'16 GB',ramLabel:'64 GB'};
  else if(u.pathname==='/api/hf/download') return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Synthetic start failure'})});
  else if(u.pathname==='/api/hf/downloads') { downloadPolls++; body={jobs:downloadJobs}; }
  else if(u.pathname.startsWith('/api/hf/search')||u.pathname.startsWith('/api/hf/modality')||u.pathname==='/api/hf/recommend') body={models:[{id:'unsloth/Qwen3-8B-GGUF',kind:'chat',pipelineTag:'text-generation',downloads:124800,likes:842,gguf:true},{id:'unsloth/gemma-3-4b-it-GGUF',kind:'chat',pipelineTag:'image-text-to-text',downloads:98200,likes:465,gguf:true},{id:'unsloth/DeepSeek-R1-8B-GGUF',kind:'chat',pipelineTag:'text-generation',downloads:68400,likes:234,gguf:true}]};
  else if(u.pathname.startsWith('/api/hf/quantizers')) body=[];
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

async function shot(name) { console.log('Checking', name); await page.waitForTimeout(350); await page.screenshot({path:`/tmp/duckpond-${name}.png`,fullPage:true,animations:'disabled'}); }
async function noOverflow() { assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)); }
await page.goto(`${previewUrl}/u/1/recovery-test+42`);
await page.getByText('History stays here',{exact:true}).waitFor();
await page.getByTitle('Switch model (Ctrl+K)').click();
await page.getByRole('textbox',{name:'Find a model'}).or(page.getByRole('searchbox',{name:'Find a model'})).waitFor();
await shot('picker-desktop');
await page.getByRole('searchbox',{name:'Find a model'}).fill('atlas');
assert.equal(await page.getByRole('option').count(),1);
await page.getByRole('searchbox',{name:'Find a model'}).fill('not-here');
assert.equal(await page.getByRole('option').count(),0);
await page.keyboard.press('Escape');
await page.getByRole('button',{name:'Settings',exact:true}).click();
await page.getByRole('heading',{name:'Appearance',exact:true}).waitFor();
await shot('settings-desktop');
await page.getByRole('button',{name:'Generation',exact:true}).click();
await page.getByRole('heading',{name:'Generation',exact:true}).waitFor();
// Navigation between sections must retain edits until Save.
await page.locator('#sec-generation input[type=range]').first().fill('1.2');
await page.getByRole('button',{name:'Tools',exact:true}).click();
await shot('settings-tools');
await page.getByRole('button',{name:'Generation',exact:true}).click();
assert.equal(await page.locator('#sec-generation input[type=range]').first().inputValue(),'1.2');
await page.getByRole('searchbox',{name:'Find a settings section'}).fill('github');
assert.equal(await page.locator('.secnav .navitem').count(),1);
await page.getByRole('button',{name:'GitHub',exact:true}).click();
await page.getByRole('heading',{name:'GitHub',exact:true}).waitFor();
await page.getByRole('searchbox',{name:'Find a settings section'}).fill('');
await page.goto(`${previewUrl}/u/1/providers`);
await page.getByRole('heading',{name:'Your connections'}).waitFor();
await shot('connections-desktop');
await page.getByRole('button',{name:'Model routing',exact:true}).click();
await page.locator('.chipid').first().waitFor();
await shot('routing-desktop');
await page.getByRole('button',{name:'move down',exact:true}).first().click();
await page.waitForFunction(()=>document.querySelector('.chipid')?.textContent==='atlas-small');
await page.getByRole('button',{name:'Add provider',exact:true}).click();
await page.getByRole('heading',{name:'Add a connection'}).waitFor();
await shot('add-provider-desktop');
for (const width of [390,768]) {
  await page.setViewportSize({width,height:844});
  await page.goto(`${previewUrl}/u/1/settings`);
  await page.getByRole('heading',{name:'Appearance',exact:true}).waitFor();
  await noOverflow(); await shot(`settings-${width}`);
  await page.getByRole('button',{name:'Account',exact:true}).click();
  await page.getByRole('heading',{name:'Account',exact:true}).waitFor();
  await noOverflow();
  await page.goto(`${previewUrl}/u/1/providers`);
  await page.getByRole('button',{name:'Model routing',exact:true}).click();
  await page.locator('.chipid').first().waitFor();
  await noOverflow(); await shot(`routing-${width}`);
  await page.getByRole('button',{name:'Add provider',exact:true}).click();
  await page.getByRole('heading',{name:'Add a connection'}).waitFor();
  await noOverflow(); await shot(`add-provider-${width}`);
}
conversation.messages=[{id:1,parent_id:null,role:'user',content:'Build a simple Snake game and show my workspace overview.'},{id:2,parent_id:1,role:'assistant',run_id:7,content:'Your project is ready. The build passed.'},
{id:3,parent_id:2,role:'assistant',content:'```duckwidget\n'+JSON.stringify({id:'weather',type:'weather',data:{place:'Chicago',current:{code:1,isDay:true,temp:24,feelsLike:25,humidity:64,wind:12},daily:[{date:'2026-09-07',code:1,max:25,min:18},{date:'2026-09-08',code:3,max:22,min:17},{date:'2026-09-09',code:61,max:21,min:16}]}})+'\n```\n\n```duckwidget\n'+JSON.stringify({id:'table',type:'table',data:{title:'Project files',columns:['File','Lines'],rows:[['index.html',48],['style.css',126],['game.js',212]]}})+'\n```'}];
conversation.active_leaf_id=3;
await page.setViewportSize({width:1440,height:1100});
await page.goto(`${previewUrl}/u/1/recovery-test+42`);
await page.locator('.diffhead').waitFor();
assert.equal(await page.locator('.diff .lines').count(),0);
await shot('tools-widgets-desktop');
await page.locator('.diffhead').click();
await page.locator('.diff .lines').waitFor();
await page.locator('.outhead').click();
await page.getByText('Build completed successfully.',{exact:true}).waitFor();
await shot('tools-expanded-desktop');
await page.locator('.diffhead').click();
await page.locator('.tbl th button').nth(1).click();
assert.equal(await page.locator('.tbl th').nth(1).getAttribute('aria-sort'),'ascending');
await page.setViewportSize({width:390,height:844});
await noOverflow(); await shot('tools-widgets-mobile');
// Auxiliary panels with populated data and mobile tabs.
for (const width of [1440,390]) {
  await page.setViewportSize({width,height:1000});
  for (const view of ['files','stats','costs']) {
    await page.goto(`${previewUrl}/u/1/${view}`);
    await page.locator(`.${view} h1`).waitFor();
    if(view==='files') {
      assert.equal(await page.locator('details.studio').getAttribute('open'),null);
      await page.locator('.files .tabs button').filter({hasText:'Docs'}).click();
      await page.getByText('Project notes.md',{exact:true}).waitFor();
    }
    await noOverflow(); await shot(`${view}-${width}`);
  }
}
// Eight simultaneous downloads must take the same fixed space as one.
downloadJobs=Array.from({length:8},(_,i)=>({repoId:`example/model-${i}`,include:'Q4.gguf',variant:'Q4.gguf',state:'running',downloadedBytes:1e9,totalBytes:10e9,speedBytesPerSec:1e8,etaSec:90,startedAt:Date.now()+i,generation:1}));
for(const width of [1440,390]) {
  await page.setViewportSize({width,height:width < 500 ? 844 : 1000});
  await page.goto(`${previewUrl}/u/1/hub`);
  await page.getByRole('button',{name:'View downloads'}).waitFor();
  await page.locator('.split .list .rrow').first().waitFor();
  assert.equal(await page.locator('.download-summary').count(),1);
  assert((await page.locator('.split').boundingBox()).height>200,'catalog remains usable with active downloads');
  await shot(`hub-downloads-${width}`);
  const before=downloadPolls;
  downloadJobs=downloadJobs.map(j=>({...j,downloadedBytes:5e9,etaSec:50}));
  await page.waitForFunction(()=>document.querySelector('.download-progress')?.textContent.includes('50%'));
  assert(downloadPolls>before,'progress changed via polling without navigation');
  await page.getByRole('button',{name:'View downloads'}).click();
  assert.equal(await page.locator('.downloadstab .jobbar').count(),8);
  await noOverflow(); await shot(`downloads-${width}`);
  downloadJobs=downloadJobs.map(j=>({...j,downloadedBytes:1e9,etaSec:90}));
}
// Failed starts remain actionable, rather than pretending to download forever.
downloadJobs=[];
await page.setViewportSize({width:1440,height:1000});
await page.goto(`${previewUrl}/u/1/hub`);
await page.locator('.split .list .rrow').first().click();
await page.locator('.vhead .dlbtn').click();
await page.getByRole('button',{name:'View downloads'}).waitFor();
await page.getByRole('button',{name:'View downloads'}).click();
await page.locator('.downloadstab').getByText('Synthetic start failure',{exact:true}).waitFor();
const failurePoll=downloadPolls;
await page.waitForFunction(()=>document.querySelector('.downloadstab .dltag.error'));
await page.waitForTimeout(3200);
assert(downloadPolls>failurePoll);
await page.locator('.downloadstab').getByText('Synthetic start failure',{exact:true}).waitFor();
// A live agent stream can be stepped, disconnected and resumed without inference.
await page.addInitScript(()=>{
  const realFetch=window.fetch;
  window.__liveConnections=0;
  window.fetch=(input,init)=>{
    if(new URL(typeof input==='string'?input:input.url,location.href).pathname==='/api/conversations/42/live') {
      window.__liveConnections++;
      return Promise.resolve(new Response(new ReadableStream({start(controller){
        window.__emitLive=event=>controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        window.__dropLive=()=>controller.close();
        window.__emitLive({type:'resume',status:'running',text:'Building the project',run:{id:7,status:'running',workspace_id:1},workspace:{id:1},context:{used:1000,budget:32768,estimated:true},promptN:1000});
      }}),{headers:{'content-type':'text/event-stream'}}));
    }
    return realFetch(input,init);
  };
});
conversation.workspace_id=null;
conversation.messages=[{id:1,parent_id:null,role:'user',content:'Keep my earlier message'},{id:2,parent_id:1,role:'assistant',content:'Earlier saved answer'}];
conversation.active_leaf_id=2;
await page.setViewportSize({width:1600,height:1000});
await page.goto(`${previewUrl}/u/1/recovery-test+42`);
await page.frameLocator('iframe[title="Project preview"]').getByText('Snake preview 1').waitFor();
projectVersion=2;
await page.evaluate(()=>{
  window.__emitLive({type:'agent',event:{id:41,type:'diff',path:'index.html',after:'<h1>Updated game</h1>'}});
  window.__emitLive({type:'tok_s',n:1500,promptN:1000,estimated:true});
});
await page.frameLocator('iframe[title="Project preview"]').getByText('Snake preview 2').waitFor();
assert.match(await page.locator('.ctx .num').innerText(),/~2.5k/);
await shot('live-project-desktop');
await page.evaluate(()=>window.__dropLive());
await page.waitForFunction(()=>window.__liveConnections>=2);
await page.getByText('Keep my earlier message',{exact:true}).waitFor();
const finalMsg={id:3,parent_id:2,role:'assistant',content:'Recovered final answer'};
conversation.messages.push(finalMsg); conversation.active_leaf_id=3;
await page.evaluate(msg=>{
  window.__emitLive({type:'done',msg});
  window.__emitLive({type:'done',msg}); // duplicate tail after reconnect
  window.__dropLive();
},finalMsg);
await page.getByText('Recovered final answer',{exact:true}).waitFor();
assert.equal(await page.getByText('Recovered final answer',{exact:true}).count(),1);
await page.getByText('Keep my earlier message',{exact:true}).waitFor();

assert.deepEqual(errors,[]);
assert.deepEqual(external,[]);
console.log('Layout and reliability browser checks passed: settings, provider routing, picker, files/stats/costs, eight live downloads with updating progress/ETA, auto-refreshing project preview, live context, reconnect and duplicate-event recovery; no external requests or page errors.');
await browser.close();
