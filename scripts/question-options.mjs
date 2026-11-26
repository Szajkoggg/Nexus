// Browser regression for the shared question choice/answer forms. Build @nexus/web first.
// node scripts/question-options.mjs [output-directory]
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { ProjectStore, newId, writeRegistry, loadProjectState, approveQueue } from '../packages/protocol/src/index.ts';
import { EdgeBrowser } from './capture/edge.ts';
import { freePort, startInstance } from './capture/run.ts';
import { requireTempHome } from './temp-home.ts';
const root = resolve(import.meta.dirname, '..');
const out = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), 'nexus-question-options-')));
const temp = join(out, 'run-' + Date.now()), home = join(temp, 'home');
mkdirSync(home, {recursive:true}); process.env.NEXUS_HOME = home; requireTempHome();
const long = 'Keep the compact list with the complete description visible on every screen';
const fixtures = [1440, 492, 390, 'other'].map(width => {
  const id = 'options-' + width, data = join(temp, id);
  mkdirSync(data, {recursive:true});
  const st = ProjectStore.init(data, {id, name:id, root:data});
  st.writeQueue({protocol:1,id:'Q',title:'Question options',revision:1,status:'proposed',stop_conditions:[],checks:[],steps:[{id:'Q1',title:'Choose',goal:'Answer separately',acceptance:[]}]});
  approveQueue(st,'Q');
  const session = newId();
  st.writeSession({protocol:1,id:session,project:id,role:'worker',runtime:'external',cwd:data,launched_by:'external',created_at:new Date().toISOString(),queue:'Q'});
  const emit = body => st.appendEvent({v:1,id:newId(),at:new Date().toISOString(),session,...body});
  emit({type:'step.started',queue:'Q',step:'Q1'});
  for (const [qid,text,options] of [['q1','Which layout should we use?',[long,'Use a grid']],['q2','Do you accept the screen design?',['Accept the design and screens','Revise the spacing']],['q3','Any other instructions?',undefined],['q4','Choose a sound',['Bell','Chime']],['q6','Choose a route',['Direct','Scenic']]]) emit({type:'question.asked',queue:'Q',step:'Q1',qid,text,options,recommended:options?.[0],can_continue:false});
  return {id, root:data, st, session, emit};
});
writeRegistry({protocol:1,projects:fixtures.map(({id,root}) => ({id,root}))});
const preload = `(() => {
 const original = window.fetch.bind(window), requests = [];
 window.fetch = async (...args) => {
  const url = String(args[0]), opt = args[1], d = document.documentElement.dataset;
  if (opt?.method === 'POST') {
   requests.push({url,body:JSON.parse(opt.body)}); d.requests = JSON.stringify(requests);
   if(url.endsWith('/answer')) {
    await new Promise(r => setTimeout(r, Number(d.delay) || 0));
    if(d.fail === 'true') return new Response(JSON.stringify({error:'Simulated save failure'}),{status:503,headers:{'content-type':'application/json'}});
   }
  }
  const response = await original(...args);
  if(url.endsWith('/state') && d.reverse === 'true') {
   const data = await response.clone().json(); for(const q of data.queues) q.questions.reverse();
   return new Response(JSON.stringify(data),{status:response.status,headers:response.headers});
  }
  return response;
 };
})();`;
const sleep = ms => new Promise(r => setTimeout(r,ms));
let inst, browser;
const logs = [];
const requests = () => browser.evaluate(`JSON.parse(document.documentElement.dataset.requests || '[]')`);
const ui = () => browser.evaluate(`({hash:location.hash,text:[...document.querySelectorAll('aside')].at(-1)?.innerText,choices:[...document.querySelectorAll('[data-answer-qid] [role=radio][aria-checked=true]')].map(e=>e.innerText),words:[...document.querySelectorAll('aside textarea')].map(e=>e.value)})`);
const record = async (name,f) => { logs.push({name,ui:await ui(),requests:await requests(),questions:loadProjectState(f.st).questions,inbox:f.st.readInbox(f.session).entries}); writeFileSync(join(out,'observations.json'),JSON.stringify(logs,null,2)); console.log('PASS',name); };
const until = async (check,name) => {for(let i=0;i<80;i++){if(await check())return;await sleep(100);} writeFileSync(join(out,'failure.json'),JSON.stringify(await ui(),null,2));throw Error('Timed out: '+name);};
const scope = qid => `[data-answer-qid=${qid}]`;
const select = async (qid,index) => {assert.equal(await browser.click({selector:scope(qid)+` [role=radio]:nth-child(${index})`}),true);};
const words = async (qid,text) => {assert.equal(await browser.type(text,scope(qid)+' textarea'),true);};
const send = async (qid,bar) => {await browser.evaluate(`(() => {const b=${bar ? `innerWidth < 1024 ? [...document.querySelectorAll('aside button')].filter(b=>b.innerText === 'Answer').at(-1) : [...document.querySelectorAll('${scope(qid)} button')].find(b=>b.innerText === 'Answer')` : `[...document.querySelectorAll('${scope(qid)} button')].find(b=>b.innerText === 'Answer')`}; b.click(); b.click();})()`);};
const route = async (id,qid='') => {await browser.evaluate(`location.hash=${JSON.stringify('#/'+id+'/Q/Q1'+(qid?'/'+qid:''))}`);await sleep(500);};
const open = async (f,width,qid='q1') => {await browser.open(inst.url+'/#/'+f.id+'/Q/Q1/'+qid,width,width===1440?900:844,preload);await until(()=>browser.evaluate(`!!document.querySelector('${scope(qid)} textarea')`),'question form');};
try {
 inst = await startInstance({root,home,port:await freePort()}); browser = await EdgeBrowser.launch(join(temp,'edge'));
 for(const width of [1440,492,390]) {
  const f=fixtures.find(f=>f.id==='options-'+width), state=()=>loadProjectState(f.st), question=qid=>state().questions.find(q=>q.qid===qid);
  await open(f,width);
  assert.deepEqual((await ui()).choices,[],'recommendation is not a user choice');
  assert.equal(await browser.evaluate(`document.querySelectorAll('${scope('q1')} [role=radio]').length`),2,'one selector for primary');
  await select('q1',1); await words('q1','Keep all descriptions');
  assert.equal((await requests()).length,0,'choosing and typing never send');
  await browser.evaluate(`document.documentElement.dataset.reverse='true'`);
  f.emit({type:'question.asked',queue:'Q',step:'Q1',qid:'q5',text:'A later question',can_continue:false});
  await sleep(1000);
  assert.match((await ui()).choices.join(),/compact list/); assert.ok((await ui()).words.includes('Keep all descriptions'));
  assert.equal((await ui()).hash,'#/'+f.id+'/Q/Q1/q1');
  await record('selection-survives-live-refresh-'+width,f);
  // A different target (including a different project with the same qid) never inherits a choice.
  await route(f.id,'q3'); assert.equal(await browser.evaluate(`document.querySelector('${scope('q3')} textarea').value`),'');
  await route('options-other','q1'); assert.deepEqual((await ui()).choices,[]); assert.equal(await browser.evaluate(`document.querySelector('${scope('q1')} textarea').value`),'');
  await open(f,width); assert.ok((await ui()).words.includes('Keep all descriptions')); assert.deepEqual((await ui()).choices,[],'selection stays in memory, not a persisted decision');
  await record('switch-and-reload-isolation-'+width,f);
  // Three simultaneous drafts and choices remain independent while the second card is answered.
  await select('q1',1); await select('q4',2); await words('q4','Quiet chime');
  await select('q2',1); await words('q2','With the readable spacing');
  await browser.click({selector:scope('q2')+' input[type=checkbox]'});
  await browser.evaluate(`document.documentElement.dataset.fail='true'`);
  await send('q2',false); await until(async()=>(await ui()).text.includes('Simulated save failure'),'save error');
  assert.match((await ui()).choices.join(),/Accept the design/); assert.ok((await ui()).words.includes('With the readable spacing'));assert.equal(question('q2').state,'open');
  await record('failed-save-preserves-choice-and-words-'+width,f);
  await browser.evaluate(`document.documentElement.dataset.fail='false';document.documentElement.dataset.delay='700'`);
  const before=(await requests()).length; await send('q2',false);
  await until(()=>question('q2').state==='answered','q2 saved'); await sleep(400);
  assert.equal((await requests()).length,before+1,'double click sends once');
  assert.equal(question('q2').answers.at(-1).text,'Accept the design and screens\n\nWith the readable spacing');assert.equal(question('q2').answers.at(-1).continue,false);
  assert.equal(question('q1').state,'open');
  const entry=f.st.readInbox(f.session).entries.find(e=>e.id==='answer-'+question('q2').answers.at(-1).id);
  assert.equal(entry.qid,'q2');assert.equal(entry.text,question('q2').answers.at(-1).text);
  assert.ok((await requests()).every(r=>r.url.endsWith('/questions/q2/answer')),'question acceptance never posts a review');
  assert.equal(await browser.evaluate(`document.querySelector('${scope('q1')} [aria-checked=true]').innerText.includes('compact list')`),true);
  assert.equal(await browser.evaluate(`document.querySelector('${scope('q4')} textarea').value`),'Quiet chime');
  assert.equal(await browser.evaluate(`document.querySelector('${scope('q4')} [aria-checked=true]').innerText.includes('Chime')`),true);
  await record('three-independent-question-cards-'+width,f);
  // Keyboard arrows choose, then Ctrl+Enter submits the primary option without words.
  await words('q1','');
  await browser.evaluate(`document.querySelector('${scope('q1')} [role=radio]').focus()`);await browser.press('ArrowDown');
  assert.match((await ui()).choices.join(),/Use a grid/);assert.equal((await requests()).length,before+1);
  // Use trusted keyboard input through CDP, since EdgeBrowser.press intentionally dispatches only DOM events.
  await browser.evaluate(`document.querySelector('${scope('q1')} textarea').focus()`);
  await browser.cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,modifiers:2});
  await browser.cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,modifiers:2});
  await until(()=>question('q1').state==='answered','keyboard primary');
  assert.equal(question('q1').answers.at(-1).text,'Use a grid');assert.equal(question('q1').answers.at(-1).continue,true);
  await record('keyboard-option-only-primary-'+width,f);
  await open(f,width,'q3');await words('q3','Free text without options');await send('q3',true);
  await until(()=>question('q3').state==='answered','no options free text');assert.equal(question('q3').answers.at(-1).text,'Free text without options');
  await open(f,width,'q4');await words('q4','Silent please');await send('q4',true);
  await until(()=>question('q4').state==='answered','free text instead of options');assert.equal(question('q4').answers.at(-1).text,'Silent please');
  await record('free-text-with-and-without-options-'+width,f);
  await open(f,width,'q6'); await select('q6',2); await words('q6','Stop at the lake');
  await browser.evaluate(`document.documentElement.dataset.fail='true'`); await send('q6',true);
  await until(async()=>(await ui()).text.includes('Simulated save failure'),'primary save error');
  assert.match((await ui()).choices.join(),/Scenic/); assert.ok((await ui()).words.includes('Stop at the lake'));
  await browser.evaluate(`document.documentElement.dataset.fail='false';document.documentElement.dataset.delay='700'`);
  await send('q6',true); await words('q6','New words during saving');
  await until(()=>question('q6').state==='answered','primary choice and words');
  assert.equal(question('q6').answers.at(-1).text,'Scenic\n\nStop at the lake');
  assert.ok(await browser.evaluate(`localStorage.getItem('nexus.drafts').includes('New words during saving')`));
  await record('primary-choice-and-words-failed-and-slow-save-'+width,f);

 }
 // Measure the same long-option fixture at every requested width through the standard CLI.
 const f=fixtures[3];
 for(const width of [1440,492,390]) {
  const args=['scripts/layout-faults.ts',inst.url+'/#/'+f.id+'/Q/Q1/q1','--width',String(width),'--boxes','aside [role=radio]','--wait','1200'];
  const result=await new Promise(resolve=>{let output='';const p=spawn(process.execPath,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});p.stdout.on('data',d=>output+=d);p.stderr.on('data',d=>output+=d);p.on('exit',code=>resolve({code,output}));});
  writeFileSync(join(out,'layout-'+width+'.txt'),result.output); console.log(result.output);
  // Existing header truncations are reported separately; option geometry is asserted below.
  assert.ok(result.code===0 || result.code===1,'layout tool ran');
  await open(f,width);assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('aside [role=radio]')].filter(e=>e.scrollWidth>e.clientWidth+1 || e.scrollHeight>e.clientHeight+1).map(e=>e.innerText)`),[],'long options fit without clipping');
  // The raw collector does not clip offscreen boxes to their scroll containers. Record visible rectangles too.
  const geometry = await browser.evaluate(`(() => {
    const visible = el => {
      const r=el.getBoundingClientRect(); let left=Math.max(0,r.left),top=Math.max(0,r.top),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom);
      for(let p=el.parentElement;p;p=p.parentElement){const c=getComputedStyle(p),b=p.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(c.overflowY)){top=Math.max(top,b.top);bottom=Math.min(bottom,b.bottom);}if(/auto|scroll|hidden|clip/.test(c.overflowX)){left=Math.max(left,b.left);right=Math.min(right,b.right);}}
      return {text:el.innerText,left,top,right,bottom,raw:{top:r.top,bottom:r.bottom}};
    };
    return [...document.querySelectorAll('[data-answer-qid] [role=radio]')].map(visible);
  })()`);
  writeFileSync(join(out,'visible-options-'+width+'.json'),JSON.stringify(geometry,null,2));
  const visible = geometry.filter(r=>r.right>r.left && r.bottom>r.top);
  for(let i=0;i<visible.length;i++) for(const b of visible.slice(i+1)) {const a=visible[i];assert.ok(Math.min(a.right,b.right)-Math.max(a.left,b.left)<=0.5 || Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)<=0.5,'visible option buttons never overlap');}

 }
 console.log('All question-option browser regressions passed. Evidence:',out);
} finally {await browser?.close();await inst?.stop();}


