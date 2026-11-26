// Browser regression of the remaining-count UI and actual fake-worker turns. No real project or model.
// node scripts/question-wait.mjs <output-directory> (build the web workspace first)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { ProjectStore, approveQueue, loadProjectState, updateSettings, writeRegistry } from '../packages/protocol/src/index.ts';
import { EdgeBrowser } from './capture/edge.ts';
import { freePort, startInstance } from './capture/run.ts';
import { requireTempHome } from './temp-home.ts';

const root = resolve(import.meta.dirname, '..'), out = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), 'nexus-question-wait-')));
const temp = join(out, 'run-' + Date.now()), home = join(temp, 'home'), log = join(temp, 'fake.log');
mkdirSync(home, { recursive: true }); process.env.NEXUS_HOME = home; requireTempHome();
const fixtures = [1440, 492, 390].map(width => {
  const id = 'wait-' + width, data = join(temp, id); mkdirSync(data, { recursive: true });
  const store = ProjectStore.init(data, { id, name: 'Questions', root: data });
  updateSettings(store, { orchestrator: { notify: false } });
  store.writeQueue({ protocol: 1, id: 'Q', title: 'Choices', revision: 1, status: 'proposed', review_level: 1, stop_conditions: [], checks: [], steps: [
    { id: 'Q1', title: 'Choose', goal: 'FAKE: askthree', acceptance: [] }, { id: 'Q2', title: 'Next', goal: 'FAKE: done', acceptance: [] },
  ] }); approveQueue(store, 'Q');
  return { id, root: data, store, width };
});
execFileSync(process.execPath, ['scripts/capture/seed-question-wait.ts', join(temp, 'capture')], { cwd: root, env: process.env, windowsHide: true });
writeRegistry({ protocol: 1, projects: [...fixtures.map(({ id, root }) => ({ id, root })), ...['wait','answered'].map(id=>({id,root:join(temp,'capture',id)}))] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (name, check) => { for (let n = 0; n < 200; n++) { if (await check()) return; await sleep(100); } throw Error('Timed out: ' + name); };
const preload = `(() => { const original = fetch.bind(window); window.fetch = async (...args) => {
  if (String(args[0]).endsWith('/answer') && args[1]?.method === 'POST') {
    if (sessionStorage.fail === 'true') return new Response(JSON.stringify({error:'Simulated save failure'}), {status:503,headers:{'content-type':'application/json'}});
    await new Promise(r=>setTimeout(r,300));
  } return original(...args);
}; })();`;
let inst, browser, second;
const observations = [];
const scope = qid => `[data-answer-qid="${qid}"]`;
const clickSend = qid => `(() => { const buttons = [...document.querySelectorAll(innerWidth < 1024 ? 'aside button' : '${scope(qid)} button')]; buttons.findLast(b=>b.textContent==='Answer').click(); })()`;
const remaining = () => browser.evaluate(`document.querySelector('aside [data-question-wait]')?.dataset.remaining`);
const texts = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(s => JSON.parse(s)) : [];
const record = async (name, f) => {
  observations.push({ name, width:f.width, ui:await browser.evaluate(`({hash:location.hash,waiting:document.querySelector('aside [data-question-wait]')?.textContent})`),
    questions:loadProjectState(f.store).questions, run:f.store.readRun('Q'), deliveries:f.store.readDelivered(f.store.readRun('Q').session).entries,
    turns:texts().filter(x=>x.session===f.store.readRun('Q').session) });
  writeFileSync(join(out, 'observations.json'), JSON.stringify(observations, null, 2)); console.log('PASS', name, f.width);
};
try {
  inst = await startInstance({ root, home, port:await freePort(), parentEnv:{...process.env,FAKE_LOG:log} });
  browser = await EdgeBrowser.launch(join(temp, 'edge'));
  for (const f of fixtures) {
    const state = () => loadProjectState(f.store), queue = () => state().queues[0];
    const post = async (path, body) => { const r = await fetch(inst.url+'/api/projects/'+f.id+'/'+path, {method:'POST',headers:{'content-type':'application/json',origin:inst.url},body:JSON.stringify(body)}); assert.equal(r.status,200); };
    await post('queues/Q/run', {action:'start', runtime:f.width===492?'codex':'claude'});
    await until('three questions and idle', ()=>state().questions.length===3 && f.store.readRuntime(queue().run.session)?.state==='idle');
    const [a,b,c] = state().questions, worker = queue().run.session, baseline = texts().filter(x=>x.session===worker).length;
    const open = async qid => { await browser.open(inst.url+'/#/'+f.id+'/Q/Q1/'+qid,f.width,f.width===1440?900:844,preload); await until('question form',()=>browser.evaluate(`!!document.querySelector('${scope(qid)} textarea')`)); };
    const held = () => { assert.equal(texts().filter(x=>x.session===worker).length,baseline); assert.equal(f.store.readRuntime(worker).state,'idle'); assert.equal(queue().steps[1].status,'pending'); };
    await open(a.qid); await until('three remaining',async()=>await remaining()==='3');
    await browser.click({selector:scope(a.qid)+' [role=radio]'}); await browser.type('Keep it compact',scope(a.qid)+' textarea');
    await browser.evaluate(`sessionStorage.fail='true'`); await browser.evaluate(clickSend(a.qid));
    await until('failed save visible',()=>browser.evaluate(`[...document.querySelectorAll('aside')].at(-1).innerText.includes('Simulated save failure')`));
    assert.equal(await remaining(),'3'); held(); await record('failed-save-is-not-an-answer',f);
    await browser.evaluate(`sessionStorage.fail='false'`); await browser.evaluate(clickSend(a.qid));
    await until('first saved',()=>state().questions.find(q=>q.qid===a.qid).state==='answered');
    await until('two remaining',async()=>await remaining()==='2'); held(); await record('partial-answer-saved',f);
    await open(b.qid); assert.equal(await remaining(),'2');
    await browser.evaluate(`location.hash='#/${f.id}/Q/Q1/${c.qid}'`); await sleep(400);
    await browser.evaluate('history.back()'); await until('back to exact question',()=>browser.evaluate(`!!document.querySelector('${scope(b.qid)} textarea')`));
    assert.equal(await remaining(),'2'); held(); await record('reload-and-back-keep-the-count',f);
    await browser.click({selector:scope(b.qid)+' [role=radio]'}); await browser.evaluate(clickSend(b.qid));
    await until('second saved',()=>state().questions.find(q=>q.qid===b.qid).state==='answered');
    await open(c.qid); await until('one remaining',async()=>await remaining()==='1'); held();
    await record('two-saved-one-open',f);
    // The standard layout tool measures the same waiting state, including the new reason and options.
    for (const phase of ['waiting','answered']) {
      if (phase==='answered') {
        if(f.width===1440) {
          // A real second tab, attached through CDP; its result is returned through same-origin localStorage.
          const target=await browser.cdp('Target.createTarget',{url:inst.url+'/#/'+f.id+'/Q/Q1/'+c.qid}); second=target.targetId;
          const attached=await browser.cdp('Target.attachToTarget',{targetId:second,flatten:false}); let serial=0;
          const tab=async expression=>{
            const key='qa-tab-'+(++serial);
            await browser.cdp('Target.sendMessageToTarget',{sessionId:attached.sessionId,message:JSON.stringify({id:serial,method:'Runtime.evaluate',params:{expression:`Promise.resolve().then(()=>(${expression})).then(value=>localStorage.setItem('${key}',JSON.stringify({value})),error=>localStorage.setItem('${key}',JSON.stringify({error:String(error)})))`,awaitPromise:true}})});
            await until('second tab result',()=>browser.evaluate(`localStorage.getItem('${key}') !== null`));
            const result=await browser.evaluate(`JSON.parse(localStorage.getItem('${key}'))`); assert.equal(result.error,undefined); return result.value;
          };
          await until('second tab loaded',()=>tab(`!!document.querySelector('${scope(c.qid)} textarea')`));
          await tab(`(() => { const original=window.fetch.bind(window); window.fetch=async(...args)=>{if(String(args[0]).endsWith('/answer')) {await new Promise(r=>setTimeout(r,300)); const response=await original(...args); localStorage.setItem('qa-second-response',String(response.status)); return response;} return original(...args);}; })()`);
          await tab(`document.querySelector('${scope(c.qid)} [role=radio]').click()`);
          await browser.click({selector:scope(c.qid)+' [role=radio]'});
          await Promise.all([browser.evaluate(clickSend(c.qid)),tab(clickSend(c.qid))]);
          await until('second tab save completed',()=>browser.evaluate(`localStorage.getItem('qa-second-response') === '200'`));
          await browser.cdp('Target.closeTarget',{targetId:second}); second=undefined;
        } else {
          await browser.click({selector:scope(c.qid)+' [role=radio]'}); await browser.evaluate(clickSend(c.qid));
        }
        await until('all saved and review',()=>queue().steps[0].status==='review' && f.store.readRuntime(worker)?.state==='idle');
        await until('zero remaining',async()=>await remaining()==='0');
        assert.equal(state().questions.find(q=>q.qid===c.qid).answers.length,1);
        assert.equal(texts().filter(x=>x.session===worker && x.text.startsWith('[Nexus] Answer')).length,1);
        assert.equal(queue().steps[1].status,'pending');
        await record('all-answers-one-turn-review-remains',f);
        await browser.open(inst.url+'/#/'+f.id+'/Q/Q1/'+c.qid,f.width,f.width===1440?900:844,preload);
        await until('all answered after reload',async()=>await remaining()==='0'); await record('all-answered-after-reload',f);
      }
      const result=await new Promise(resolve=>{let output='';const p=spawn(process.execPath,['scripts/layout-faults.ts',inst.url+'/#/'+(phase==='waiting'?'wait':'answered')+'/Q/Q1/q3','--width',String(f.width),'--boxes','aside [role=radio], aside [data-question-wait]','--wait','1200'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});p.stdout.on('data',d=>output+=d);p.stderr.on('data',d=>output+=d);p.on('exit',code=>resolve({code,output}));});
      writeFileSync(join(out,`layout-${phase}-${f.width}.txt`),result.output); console.log(result.output); assert.equal(result.code,0,'layout without faults');
    }
  }
  console.log('All question-wait browser regressions passed:',out);
} catch (error) {
  if (browser) writeFileSync(join(out,'failure.json'),JSON.stringify(await browser.evaluate(`({hash:location.hash,text:document.body.innerText})`),null,2));
  throw error;
} finally { if(second)await browser?.cdp('Target.closeTarget',{targetId:second}); await browser?.close(); await inst?.stop(); }
