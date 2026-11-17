// Browser regression for QA1's lost question target. Build @nexus/web first, then run:
// node scripts/question-target.mjs [output-directory]
// Uses only temporary projects and the capture helper's isolated server with fake runtimes.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ProjectStore, newId, writeRegistry, loadProjectState, approveQueue } from '../packages/protocol/src/index.ts';
import { EdgeBrowser } from './capture/edge.ts';
import { freePort, startInstance } from './capture/run.ts';
const root = resolve(import.meta.dirname, '..');
const out = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), 'nexus-question-target-')));
const temp = join(out, 'run-' + Date.now()), home = join(temp, 'home');
mkdirSync(home, { recursive: true });
process.env.NEXUS_HOME = home;
const fixtures = ['qa-repro', 'qa-other'].map(id => {
  const data = join(temp, id);
  mkdirSync(data, { recursive: true });
  const st = ProjectStore.init(data, { id, name: id, root: data });
  st.writeQueue({ protocol: 1, id: 'Q', title: 'Three separate questions', revision: 1, status: 'proposed', stop_conditions: [], checks: [], steps: [{ id: 'Q1', title: 'Choose three things', goal: 'Reproduce question navigation', acceptance: [] }] });
  approveQueue(st, 'Q');
  const worker = { protocol: 1, id: newId(), project: id, role: 'worker', runtime: 'external', cwd: data, launched_by: 'external', created_at: new Date().toISOString(), queue: 'Q' };
  st.writeSession(worker);
  let n = 0;
  const emit = body => st.appendEvent({ v: 1, id: newId(), at: new Date(Date.now() - 60000 + n++ * 1000).toISOString(), session: worker.id, ...body });
  emit({ type: 'step.started', queue: 'Q', step: 'Q1' });
  for (const [qid, text, options] of [['q1', 'ALPHA: choose a color', ['Red', 'Blue']], ['q2', 'BRAVO: choose a layout', ['Grid', 'List']], ['q3', 'CHARLIE: choose a sound', ['Bell', 'Chime']]]) emit({ type: 'question.asked', queue: 'Q', step: 'Q1', qid, text: id === "qa-other" ? "OTHER " + text : text, options: id === "qa-other" ? options.map(o => "Other " + o) : options, can_continue: false });
  return { id, root: data, st, worker, emit };
});
writeRegistry({ protocol: 1, projects: fixtures.map(({ id, root }) => ({ id, root })) });
const { st, worker, emit } = fixtures[0];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const preload = `(() => {
 const original = window.fetch.bind(window), requests = [];
 window.fetch = async (...args) => {
  const url = String(args[0]), opt = args[1], d = document.documentElement.dataset;
  if (url.startsWith('/api/projects') && (!opt?.method || opt.method === 'GET')) while (d.qaFreeze === 'true') await new Promise(r => setTimeout(r, 50));
  if (url.includes('/answer') && opt?.method === 'POST') {
   requests.push({url, body: JSON.parse(opt.body)}); d.qaRequests = JSON.stringify(requests);
   await new Promise(r => setTimeout(r, Number(d.qaDelay) || 0));
   if (d.qaFail === 'true') return new Response(JSON.stringify({error: 'QA simulated save failure'}), {status: 503, headers: {'content-type':'application/json'}});
  }
  const response = await original(...args);
  if (url.endsWith('/state') && d.qaReverse === 'true') {
   const data = await response.clone().json();
   for (const q of data.queues) q.questions.reverse();
   return new Response(JSON.stringify(data), {status: response.status, headers: response.headers});
  }
  return response;
 };
})();`;
let inst, browser, other;
const log = [];
const read = () => browser.evaluate(`(() => {
 const panel = [...document.querySelectorAll('aside')].at(-1);
 return {hash: location.hash, heading: panel?.querySelector('h1')?.innerText, text: panel?.innerText,
 inputs: [...(panel?.querySelectorAll('textarea') ?? [])].map(e => e.value),
 choices: [...document.querySelectorAll('[role=radio][aria-checked=true]')].map(e => e.innerText),
 drafts: localStorage.getItem('nexus.drafts'), requests: JSON.parse(document.documentElement.dataset.qaRequests || '[]')};
})()`);
const record = async name => {
 const state = loadProjectState(st), ui = await read();
 const item = {name, ui, questions: state.questions, remaining: state.attention.filter(a => a.kind === 'question').map(a => a.qid), inbox: st.readInbox(worker.id).entries};
 log.push(item); writeFileSync(join(out, 'observations.json'), JSON.stringify(log, null, 2)); console.log('PASS', name); return item;
};
const until = async (check, description) => {
 for (let i = 0; i < 60; i++) { if (await check()) return; await sleep(100); }
 writeFileSync(join(out, 'failure-ui.json'), JSON.stringify(await read(), null, 2));
 throw Error('Timed out: ' + description);
};
const open = async (width, hash = '#/qa-repro') => {
 await browser.open(inst.url + '/' + hash, width, width === 1440 ? 900 : 844, preload);
 await until(async () => (await read()).text || await browser.evaluate(`document.body.innerText.includes('BRAVO')`), 'fixture loaded');
 await sleep(300);
};
const clickQuestion = async name => {
 assert.equal(await browser.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(e => e.innerText.includes(${JSON.stringify(name)}) && e.innerText.includes('Question') && !e.innerText.includes('OTHER')); if (!b) return false; b.click(); return true; })()`), true);
 await sleep(400);
};
const primary = async text => {
 await browser.evaluate(`(() => { const p = [...document.querySelectorAll('aside')].at(-1); const areas = p.querySelectorAll('textarea'); (innerWidth < 1024 ? areas[0] : p.querySelector('[data-answer-qid="' + location.hash.split("/").at(-1) + '"] textarea')).setAttribute('data-qa-primary', 'true'); })()`);
 assert.equal(await browser.type(text, '[data-qa-primary]'), true);
};
const send = async () => {
 assert.equal(await browser.evaluate(`(() => {const p = [...document.querySelectorAll('aside')].at(-1); const buttons = innerWidth < 1024 ? p.querySelectorAll('button') : p.querySelector('[data-answer-qid="' + location.hash.split("/").at(-1) + '"]').querySelectorAll('button'); const b = [...buttons].filter(e => e.innerText === 'Answer').at(-1); if (!b) return false; b.click(); return true;})()`), true);
};
try {
 inst = await startInstance({root, home, port: await freePort()});
 browser = await EdgeBrowser.launch(join(temp, 'edge'));
 for (const width of [390, 492, 1440]) {
  await open(width); await clickQuestion('BRAVO');
  const ui = await read();
  assert.equal(ui.hash, '#/qa-repro/Q/Q1/q2');
  if (width < 1024) assert.equal(ui.heading, 'BRAVO: choose a layout', 'QA1 regression: clicked q2 must be the shown question');
  else {
   assert.match(ui.text, /BRAVO: choose a layout/);
   assert.equal(await browser.evaluate(`(() => {
    const form = document.querySelector('[data-answer-qid=q2]'); const r = form.getBoundingClientRect();
    const buttons = [...document.querySelectorAll('aside button')].filter(b => b.innerText === 'Answer');
    return r.top >= 0 && r.top < innerHeight && buttons.every(b => b.closest('[data-answer-qid]'));
   })()`), true, 'the clicked desktop question is visible and every answer button belongs to its card');
  }
  await primary('BRAVO draft ' + width);
  await record('second-question-' + width);
  await open(width, '#/qa-repro/Q/Q1/q2');
  assert.ok((await read()).inputs.includes('BRAVO draft ' + width));
  await record('reload-' + width);
 }
 await open(492); assert.equal(await browser.click('2 · List'), true); await sleep(400);
 assert.match((await read()).choices.join(), /List/);
 await primary('BRAVO own words');
 await browser.click({selector: 'aside input[type=checkbox]'});
 await browser.click({selector: 'button[aria-label=Back]'}); await sleep(400);
 await clickQuestion('CHARLIE');
 assert.equal((await read()).heading, 'CHARLIE: choose a sound');
 assert.equal((await read()).inputs[0], '');
 assert.deepEqual((await read()).choices, []);
 assert.equal(await browser.evaluate(`document.querySelector('aside input[type=checkbox]').checked`), true);
 await open(492, '#/qa-other/Q/Q1/q2');
 assert.equal((await read()).inputs[0], '', 'same qid in another project has its own draft');
 await primary('OTHER project draft');
 await open(492, '#/qa-repro/Q/Q1/q2');
 assert.equal((await read()).inputs[0], 'BRAVO own words');
 await record('back-project-isolation');
 // Live refresh with reversed question order: the explicit q2 target must not change.
 await browser.evaluate(`document.documentElement.dataset.qaReverse='true'`);
 emit({type:'question.asked',queue:'Q',step:'Q1',qid:'q4',text:'DELTA: another question',can_continue:false});
 await sleep(1300);
 assert.equal((await read()).heading, 'BRAVO: choose a layout');
 assert.equal((await read()).inputs[0], 'BRAVO own words');
 await record('new-and-reordered-questions');
 await browser.evaluate(`document.documentElement.dataset.qaFail='true'`);
 await send(); await until(async () => (await read()).text.includes('QA simulated save failure'), 'visible save error');
 assert.equal((await read()).inputs[0], 'BRAVO own words');
 assert.equal(loadProjectState(st).questions.find(q => q.qid === 'q2').state, 'open');
 await record('failed-save-retains-draft');
 await browser.evaluate(`document.documentElement.dataset.qaFail='false'; document.documentElement.dataset.qaDelay='1200'`);
 await browser.click({selector:'[role=radio]:nth-child(2)'});
 await browser.click({selector:'aside input[type=checkbox]'});
 await send(); await sleep(100); await primary('New words while saving');
 await until(() => loadProjectState(st).questions.find(q => q.qid === 'q2').state === 'answered', 'q2 answered');
 await until(async () => (await read()).text.includes('answered'), 'answer rendered');
 const saved = await record('slow-save-exact-target');
 const answer = saved.questions.find(q => q.qid === 'q2').answers.at(-1);
 assert.equal(answer.text, 'List\n\nBRAVO own words'); assert.equal(answer.continue, false);
 assert.equal(saved.ui.requests.at(-1).url, '/api/projects/qa-repro/questions/q2/answer');
 assert.equal(saved.ui.requests.at(-1).body.text, answer.text);
 assert.equal(saved.inbox.find(e => e.id === 'answer-' + answer.id)?.qid, 'q2');
 assert.equal(saved.inbox.find(e => e.id === 'answer-' + answer.id)?.text, answer.text);
 assert.equal(saved.ui.hash, '#/qa-repro/Q/Q1/q2');
 assert.ok(saved.ui.drafts.includes('New words while saving'));
 assert.deepEqual(saved.remaining.sort(), ['q1', 'q3', 'q4']);
 // A target closed by another page remains that target; additional API answers still work.
 await open(492, '#/qa-repro/Q/Q1/q3'); await primary('CHARLIE stale draft');
 await browser.evaluate(`document.documentElement.dataset.qaFreeze='true'`);
 other = await EdgeBrowser.launch(join(temp, 'other-edge'));
 await other.open(inst.url + '/#/qa-repro/Q/Q1/q3', 492, 844);
 await until(() => other.evaluate(`document.querySelector('aside h1')?.innerText === 'CHARLIE: choose a sound'`), 'other page loaded');
 assert.equal(await other.type('Other page answer', 'aside textarea'), true);
 await other.evaluate(`(() => { const p = [...document.querySelectorAll('aside')].at(-1); p.querySelector('input[type=checkbox]').click(); [...p.querySelectorAll('button')].filter(b => b.innerText === 'Answer').at(-1).click(); })()`);
 await until(() => loadProjectState(st).questions.find(q => q.qid === 'q3').answers.length === 1, 'other browser answer saved');
 await other.close(); other = undefined;
 await send(); await until(() => loadProjectState(st).questions.find(q => q.qid === 'q3').answers.length === 2, 'existing additional-answer contract');
 await browser.evaluate(`document.documentElement.dataset.qaFreeze='false'`); await sleep(900);
 assert.equal((await read()).hash, '#/qa-repro/Q/Q1/q3');
 await record('already-answered-exact-target');
 await open(492, '#/qa-repro/Q/Q1/q1'); await primary('ALPHA before withdrawal');
 await browser.evaluate(`document.documentElement.dataset.qaFreeze='true'`);
 emit({type:'question.withdrawn',qid:'q1',reason:'Fixture withdrawal'}); await sleep(500);
 await send(); await until(async () => (await read()).text.includes('the question was withdrawn'), 'withdrawal error');
 assert.equal((await read()).inputs[0], 'ALPHA before withdrawal');
 await record('withdrawn-save-error');
 await browser.evaluate(`document.documentElement.dataset.qaFreeze='false'`); await sleep(900);
 assert.equal((await read()).hash, '#/qa-repro/Q/Q1/q1');
 assert.match((await read()).text, /withdrawn/);
 await record('withdrawn-target-stays');
 await open(492, '#/qa-repro/Q/Q1/missing');
 assert.match((await read()).text, /This question is no longer available/);
 await record('missing-target');
 await open(492, '#/qa-other'); assert.equal(await browser.click('Go through them one by one'), true); await sleep(400);
 // The digest spans projects, so use the route's current project and question as its source of truth.
 const first = await read(); const parts = first.hash.split('/'); const qid = parts.at(-1), project = parts[1];
 assert.ok(qid.startsWith('q'));
 await primary('Sequential answer'); await send();
 await until(async () => (await read()).hash !== first.hash, 'next distinct waiting question');
 const next = await record('sequential-distinct-question');
 assert.notEqual(next.ui.hash, first.hash);
 assert.equal(loadProjectState(fixtures.find(f => f.id === project).st).questions.find(q => q.qid === qid).state, 'answered');
 assert.ok(!next.ui.inputs.includes('Sequential answer'), 'next question never inherits sent words');
 const allOpen = () => fixtures.reduce((count, f) => count + loadProjectState(f.st).questions.filter(q => q.state === 'open' || q.state === 'escalated').length, 0);
 const countBefore = allOpen();
 for (const [qid, text] of [['q5', 'ECHO: choose a route'], ['q6', 'FOXTROT: choose a font'], ['q7', 'GOLF: choose a size']]) emit({type:'question.asked', queue:'Q', step:'Q1', qid, text, can_continue:false});
 await open(1440); await clickQuestion('FOXTROT');
 assert.equal((await read()).hash, '#/qa-repro/Q/Q1/q6');
 await primary('Sans: desktop answer for FOXTROT'); await send();
 await until(() => loadProjectState(st).questions.find(q => q.qid === 'q6').state === 'answered', 'desktop exact answer');
 await until(async () => (await read()).text.includes('Sans: desktop answer for FOXTROT'), 'desktop answer rendered');
 const desktop = await record('desktop-answer-exact-target');
 assert.equal(desktop.ui.requests.at(-1).url, '/api/projects/qa-repro/questions/q6/answer');
 assert.equal(desktop.questions.find(q => q.qid === 'q6').answers.at(-1).text, 'Sans: desktop answer for FOXTROT');
 assert.equal(desktop.questions.find(q => q.qid === 'q5').state, 'open');
 assert.equal(desktop.questions.find(q => q.qid === 'q7').state, 'open');
 assert.equal(allOpen(), countBefore + 2, 'exactly one of the three new questions closed');
 console.log('All browser question-target regressions passed. Evidence:', out);
} finally { await other?.close(); await browser?.close(); await inst?.stop(); }
