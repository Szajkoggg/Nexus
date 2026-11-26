// Browser regression of the review decisions in the dashboard (queue RVD, RVD4): a development instance of its own
// (a free port from 4318, NEXUS_HOME in a temporary folder) with the fake runtimes, its test projects only, and headless
// Edge. It checks what the page shows (the texts, the focus, the disabled Accept and its reason) and what the files
// then hold, never only the API's reply. Build @nexus/web first.
//   node scripts/review-decisions.mjs [output-directory]
// The evidence (observations.json, the layout measurements) goes to the output directory.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { ProjectStore, approveQueue, loadProjectState, newId, updateSettings, writeAway, writeRegistry } from '../packages/protocol/src/index.ts';
import { EdgeBrowser } from './capture/edge.ts';
import { freePort, startInstance } from './capture/run.ts';

const root = resolve(import.meta.dirname, '..');
const out = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), 'nexus-review-decisions-')));
const temp = join(out, 'run-' + Date.now()), home = join(temp, 'home');
mkdirSync(home, { recursive: true }); process.env.NEXUS_HOME = home;
const ago = min => new Date(Date.now() - min * 60_000).toISOString();
const LONG_Q = 'Should the waiting list on a narrow phone keep every queue group expanded so that nothing is hidden behind a tap, even when that makes the list several screens long?';
const LONG_O = 'Keep every group expanded on the phone, with the queue name and the number of waiting items above each group';
const DECISIONS = [
  ['D1', 'Which layout for the waiting list on the desktop?', ['A: one list, oldest first', 'B: grouped by queue'], 'B: grouped by queue', ['list@1440'], 'WT2 builds it; the other one is dropped.'],
  ['D2', 'What does Snooze do?', ['Hide it for an hour', 'Hide it until it changes'], 'Hide it until it changes', [], 'When a snoozed item comes back to the list.'],
  ['D3', 'Does the phone\'s Waiting tab change in this queue?', ['Yes, in WT2', 'Later, in a queue of its own'], 'Later, in a queue of its own', ['phone@390'], 'Yes adds a step to WT; later leaves the phone as it is.'],
];
const decideArgs = ([, text, options, rec, material, why]) => JSON.stringify([text, ...options.flatMap(o => ['--option', o]), '--recommend', rec, ...material.flatMap(m => ['--material', m]), '--why', why]);

/** A png of `w`×`h` px in one colour (the viewer only needs a picture). */
function png(file) {
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  writeFileSync(file, Buffer.from(b64, 'base64'));
  return file.replaceAll('\\', '/');
}

/**
 * A test project. `run`: its queue runs on the fake runtimes, the worker declaring DECISIONS (FAKE-DECIDE); else the
 * step's events are written here: the worker's decisions (`decisions`, default DECISIONS) and its step.done.
 */
function project(id, o = {}) {
  const data = join(temp, id); mkdirSync(data, { recursive: true });
  const store = ProjectStore.init(data, { id, name: o.name ?? id, root: data, orchestrator: { session: null } });
  updateSettings(store, { orchestrator: { notify: false } });
  store.markReviewLevels(ago(24 * 60)); store.markReviewDecisions(ago(24 * 60));
  const session = (role, extra = {}) => { const s = { protocol: 1, id: newId(), project: id, role, runtime: 'claude', cwd: data, launched_by: 'nexus', created_at: ago(600), ...extra }; store.writeSession(s); return s; };
  const worker = session('worker', { queue: 'Q' }), orch = session('orchestrator');
  const emit = (s, body, min) => { const e = { v: 1, id: newId(), at: min === undefined ? new Date().toISOString() : ago(min), session: s.id, queue: 'Q', ...body }; store.appendEvent(e); return e.id; };
  const goal = o.run ? ['FAKE: done', ...(o.decisions ?? DECISIONS).map(d => 'FAKE-DECIDE: ' + decideArgs(d))].join('\n') : 'Design the waiting list.';
  store.writeQueue({ protocol: 1, id: 'Q', title: 'Waiting tab redesign', revision: 1, status: 'proposed', review_level: o.level ?? 1, stop_conditions: [], checks: [], steps: [
    { id: 'Q1', title: 'Design: the waiting list\'s layout', kind: 'design', goal, acceptance: ['Both layouts drawn'] },
    { id: 'Q2', title: 'Build the chosen layout', goal: 'FAKE: done', acceptance: [] },
  ] });
  approveQueue(store, 'Q');
  // The step's events end `doneAt` minutes ago (default 27).
  const t0 = o.doneAt ?? 27;
  if (!o.run) {
    emit(worker, { type: 'step.started', step: 'Q1' }, t0 + 3);
    for (const [d, text, options, recommended, material, why] of o.decisions ?? DECISIONS) {
      emit(worker, { type: 'review.decision', step: 'Q1', decision: d, text, options: options.map(label => ({ label, ...(o.fixOption === label ? { effect: 'fix' } : {}) })), recommended, material, why, for: 'user' }, t0 + 2);
    }
    if (o.pictures) emit(worker, { type: 'review.added', step: 'Q1', round: 1, items: o.pictures(data) }, t0 + 1);
    emit(worker, { type: 'step.done', step: 'Q1', summary: 'Two layouts, A and B; three decisions for you.' }, t0);
  }
  const state = () => loadProjectState(store);
  const queue = () => state().queues.find(q => q.id === 'Q');
  const step = (s = 'Q1') => queue().steps.find(x => x.id === s);
  return { id, root: data, store, worker, orch, emit, state, queue, step };
}

const pictures = data => [
  { path: png(join(data, 'list-a.png')), label: 'A: one list', kind: 'image', key: 'list@1440', role: 'variant-a' },
  { path: png(join(data, 'list-b.png')), label: 'B: grouped', kind: 'image', key: 'list@1440', role: 'variant-b' },
  { path: png(join(data, 'phone.png')), label: 'Phone', kind: 'image', key: 'phone@390', role: 'result' },
];
const P = {
  main: project('rd-main', { run: true }),
  round: project('rd-round', { run: true }),
  view: project('rd-view', { pictures }),
  fail: project('rd-fail', { decisions: [...DECISIONS.slice(0, 2), ['D3', LONG_Q, [LONG_O, 'Collapse the groups'], LONG_O, [], 'A long question and option.']], fixOption: 'Collapse the groups' }),
  other: project('rd-other'),
  reject: project('rd-reject'),
  fix0: project('rd-fix0'),
  away: project('rd-away', { level: 2, doneAt: 150 }),
  batch: project('rd-batch', { level: 3, doneAt: 150 }),
  batch2: project('rd-batch2', { level: 3, doneAt: 150 }),
};
// Away mode from 4 hours ago until 1 hour ago: the orchestrator's answers in it are "while you were away".
writeAway({ protocol: 1, past: [{ since: ago(240), until: ago(60), ended: ago(60), why: 'expired' }] });
// rd-away (level 2): the orchestrator answered D1 while the user was away, then handed the step to the user.
{
  const f = P.away;
  f.emit(f.orch, { type: 'review.decided', step: 'Q1', decision: 'D1', version: 1, round: 1, choice: 'B: grouped by queue', text: 'Many queues read better grouped.' }, 120);
  f.emit(f.orch, { type: 'review.asked_user', step: 'Q1', text: 'D2 and D3 are yours; D1 is my proposal from while you were away.' }, 30);
}
// rd-batch, rd-batch2 (level 3): the orchestrator answered every decision while away and accepted Q1 provisionally; Q2
// declared none and was accepted provisionally too.
for (const f of [P.batch, P.batch2]) {
  DECISIONS.forEach(([d, , , rec], i) => f.emit(f.orch, { type: 'review.decided', step: 'Q1', decision: d, version: 1, round: 1, choice: rec, text: 'Reason ' + d }, 120 - i));
  f.emit(f.orch, { type: 'review.provisional', step: 'Q1', text: 'the layout is yours to judge.' }, 100);
  f.emit(f.worker, { type: 'step.started', step: 'Q2' }, 90);
  f.emit(f.worker, { type: 'review.decisions_none', step: 'Q2', text: 'builds what Q1 chose' }, 89);
  f.emit(f.worker, { type: 'step.done', step: 'Q2', summary: 'Built.' }, 88);
  f.emit(f.orch, { type: 'review.provisional', step: 'Q2' }, 87);
}
writeRegistry({ protocol: 1, projects: Object.values(P).map(({ id, root }) => ({ id, root })) });

// In the page before its own scripts: a save that fails on demand, a slow save, the requests made, and a frozen live
// stream (another tab's change unseen) on demand.
const preload = `(() => {
  const d = () => document.documentElement.dataset, original = window.fetch.bind(window), requests = [];
  window.fetch = async (...args) => {
    const url = String(args[0]), opt = args[1];
    if (opt?.method === 'POST') {
      requests.push({ url, body: opt.body ? JSON.parse(opt.body) : undefined }); d().requests = JSON.stringify(requests);
      if (url.includes('/decisions/')) {
        await new Promise(r => setTimeout(r, Number(d().delay) || 0));
        if (d().fail === 'true') return new Response(JSON.stringify({ error: 'Simulated save failure' }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
    }
    if (d().freeze === 'true' && url.includes('/state')) return new Response('{}', { status: 503 });
    return original(...args);
  };
  const Socket = window.WebSocket;
  window.WebSocket = class extends Socket {
    constructor(...a) { super(...a); const add = this.addEventListener.bind(this);
      this.addEventListener = (type, f, o) => add(type, type === 'message' ? (e => { if (d().freeze !== 'true') f(e); }) : f, o); }
    set onmessage(f) { super.onmessage = e => { if (d().freeze !== 'true') f(e); }; }
  };
})();`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let inst, browser;
const logs = [];
const until = async (name, check, n = 150) => { for (let i = 0; i < n; i++) { if (await check()) return; await sleep(100); } writeFileSync(join(out, 'failure.json'), JSON.stringify(await ui(), null, 2)); throw Error('Timed out: ' + name); };
const js = expr => browser.evaluate(expr);
const ui = () => js(`(() => {
  // The step's panel when one is open (the waiting list of every project may be another aside), else the page.
  const panel = document.querySelector('[data-decisions]')?.closest('aside') ?? [...document.querySelectorAll('aside')].at(-1) ?? document.body;
  // The viewer's bar and sheet are drawn after the panel's (which stays under it): the last of each is the one in front.
  const last = sel => [...document.querySelectorAll(sel)].at(-1);
  const accept = last('[data-action=accept]');
  return {
    hash: location.hash,
    count: document.querySelector('[data-decisions-count]')?.innerText,
    hold: last('[data-accept-hold]')?.innerText, holdKind: last('[data-accept-hold]')?.dataset.acceptHold,
    accept: accept ? { text: accept.innerText, disabled: accept.disabled } : null,
    chosen: [...new Set([...document.querySelectorAll('[data-decision] [role=radio][aria-checked=true]')].map(e => e.closest('[data-decision]').dataset.decision + ':' + e.innerText.split('\\n')[0]))],
    states: Object.fromEntries([...document.querySelectorAll('[data-decision]')].map(e => [e.dataset.decision, e.dataset.state])),
    alerts: [...document.querySelectorAll('[role=alert]')].map(e => e.innerText),
    focus: document.activeElement?.closest('[data-decision]')?.dataset.decision ?? document.activeElement?.tagName,
    text: panel.innerText,
  };
})()`);
const requests = () => js(`JSON.parse(document.documentElement.dataset.requests || '[]')`);
const record = async (name, f, extra = {}) => {
  const s = f.step(), st = f.state();
  logs.push({ name, project: f.id, ui: await ui(), step: { status: s.status, round: s.decisions.items.map(d => [d.id, d.version, d.answers.map(a => [a.by, a.choice, a.round, a.version])]), accepted: s.accepted, provisional: s.provisional }, next: f.step('Q2')?.status, warnings: st.warnings, ...extra });
  writeFileSync(join(out, 'observations.json'), JSON.stringify(logs, null, 2));
  console.log('PASS', name);
};
const open = async (f, width, path = '/Q/Q1') => {
  await browser.open(inst.url + '/#/' + f.id + path, width, width >= 1024 ? 900 : 844, preload);
  // The decisions as the files hold them now: a review's count (or its missing list), or the return batch.
  await until('the page of ' + f.id, () => js(`!!document.querySelector('[data-decisions-count], [data-decisions=missing], [data-batch-step]')`));
  await sleep(600); // the live state after the first answer
};
const card = id => `[data-decision='${id}']`;
/** Clicks the last element matching `sel` (the viewer's sheet before the panel under it), focused first as a click does. */
const clickLast = sel => js(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].at(-1); if (!el) return false; el.scrollIntoView({ block: 'nearest' }); el.focus(); el.click(); return true; })()`);
const choose = async (id, n) => assert.equal(await clickLast(`${card(id)} [role=radio]:nth-child(${n})`), true, `choose ${id} ${n}`);
const save = async id => assert.equal(await clickLast(`${card(id)} [data-action=save]`), true, `save ${id}`);
const answers = (f, id) => f.step().decisions.items.find(d => d.id === id).answers;
const post = async (f, path, body) => fetch(inst.url + '/api/projects/' + f.id + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: inst.url }, body: JSON.stringify(body) });
const ctrlEnter = async () => {
  for (const type of ['keyDown', 'keyUp']) await browser.cdp('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 });
};
const layout = async (name, url, width, boxes) => {
  const args = ['scripts/layout-faults.ts', url, '--width', String(width), '--height', '2600', '--boxes', boxes, '--wait', '1500'];
  const result = await new Promise(res => { let output = ''; const p = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); p.stdout.on('data', d => output += d); p.stderr.on('data', d => output += d); p.on('exit', code => res({ code, output })); });
  writeFileSync(join(out, `layout-${name}@${width}.txt`), result.output);
  console.log(`layout ${name}@${width}: exit ${result.code}`);
  return result;
};
/** No decision control is clipped and none overlaps another, measured in the window (the scroll containers' visible part). */
const geometry = async name => {
  const g = await js(`(() => {
    const clipped = [...document.querySelectorAll('[data-decision] [role=radio], [data-decision] p, [data-action], [data-accept-hold]')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.innerText);
    // Only what is in front (the viewer covers the panel's bar): the element at its centre is it or inside it.
    const front = e => { const b = e.getBoundingClientRect(); const at = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2); return !!at && e.contains(at); };
    const r = [...document.querySelectorAll('[data-action], [data-decision] [role=radio]')].filter(front).map(e => { const b = e.getBoundingClientRect(); return { t: e.innerText, l: b.left, r: b.right, top: b.top, b: b.bottom }; }).filter(b => b.r > b.l);
    const overlaps = [];
    for (let i = 0; i < r.length; i++) for (const o of r.slice(i + 1)) if (Math.min(r[i].r, o.r) - Math.max(r[i].l, o.l) > 0.5 && Math.min(r[i].b, o.b) - Math.max(r[i].top, o.top) > 0.5) overlaps.push([r[i].t, o.t]);
    const bar = [...document.querySelectorAll('[data-action=accept], [data-action=fix]')].slice(-2).map(e => { const b = e.getBoundingClientRect(); return b.right <= innerWidth + 0.5 && b.bottom <= innerHeight + 0.5 && b.left >= -0.5; });
    return { clipped, overlaps, barVisible: bar.every(Boolean) };
  })()`);
  writeFileSync(join(out, `geometry-${name}.json`), JSON.stringify(g, null, 2));
  assert.deepEqual(g.clipped, [], name + ': nothing clipped'); assert.deepEqual(g.overlaps, [], name + ': nothing overlaps'); assert.equal(g.barVisible, true, name + ': Accept and Fix it in the window');
};

try {
  inst = await startInstance({ root, home, port: await freePort() });
  browser = await EdgeBrowser.launch(join(temp, 'edge'));
  for (const f of [P.main, P.round]) assert.equal((await post(f, '/queues/Q/run', { action: 'start', runtime: 'claude' })).status, 200);
  for (const f of [P.main, P.round]) await until(f.id + ' in review with three decisions', () => f.step().status === 'review' && f.step().decisions.items.length === 3, 400);

  // ---- 1. Three design decisions, partial then complete, Accept from the panel; the next step starts.
  {
    const f = P.main;
    await open(f, 1440);
    await until('three open decisions', async () => (await ui()).count === '0 of 3 answered');
    let u = await ui();
    assert.deepEqual(u.chosen, [], 'the recommendation is not a choice');
    assert.equal(u.accept.disabled, true); assert.equal(u.holdKind, 'open');
    assert.match(u.hold, /3 decisions open \(D1, D2, D3\): answer them to accept/);
    assert.match(u.text, /recommended/);
    assert.equal(await browser.click('Go to D1 ↓'), true); await sleep(400);
    assert.equal((await ui()).focus, 'D1', 'Go to D1 focuses the decision');
    await choose('D1', 2);
    assert.equal((await requests()).length, 0, 'choosing saves nothing');
    assert.match((await ui()).text, /Chosen, not saved/);
    await save('D1');
    await until('D1 saved', async () => (await ui()).count === '1 of 3 answered');
    u = await ui();
    assert.equal(u.accept.disabled, true); assert.match(u.hold, /2 decisions open \(D2, D3\)/);
    assert.equal(answers(f, 'D1').at(-1).choice, 'B: grouped by queue'); assert.equal(f.step().status, 'review', 'a save is no acceptance');
    assert.equal(f.step('Q2').status, 'pending');
    assert.ok((await requests()).every(r => !r.url.endsWith('/accept')), 'no Accept was sent');
    await record('partial-save-keeps-accept-disabled', f);
    // Keyboard: the arrows choose, Ctrl+Enter in the words saves.
    await js(`document.querySelector("${card('D2')} [role=radio]").focus()`); await browser.press('ArrowDown');
    assert.deepEqual((await ui()).chosen, ['D2:Hide it until it changes']);
    await js(`document.querySelector("${card('D2')} textarea").focus()`); await ctrlEnter();
    await until('D2 saved by the keyboard', async () => (await ui()).count === '2 of 3 answered');
    await record('keyboard-choice-and-ctrl-enter-save', f);
    // D3: an option, words, and Save; then Accept is a separate click.
    await choose('D3', 2); await browser.type('After WT ships', `${card('D3')} textarea`); await save('D3');
    await until('all saved', async () => (await ui()).count === 'all 3 answered');
    u = await ui();
    assert.equal(u.accept.disabled, false); assert.equal(u.hold, 'All decisions answered');
    assert.equal(f.step().status, 'review', 'answering every decision accepts nothing');
    assert.equal(answers(f, 'D3').at(-1).text, 'After WT ships');
    await record('complete-enables-accept-without-accepting', f);
    // Another tab answers D2 again while this one does not see it: Accept is refused, nothing is accepted.
    await js(`document.documentElement.dataset.freeze='true'`);
    const d2 = f.step().decisions.items.find(d => d.id === 'D2');
    assert.equal((await post(f, '/queues/Q/steps/Q1/decisions/D2/answer', { version: d2.version, round: 1, choice: 'Hide it for an hour' })).status, 200);
    await clickLast('[data-action=accept]');
    await until('the refusal shows', async () => (await ui()).alerts.some(a => /answers changed since you read them \(D2\)/.test(a)));
    assert.equal(f.step().status, 'review', 'a stale page accepts nothing');
    await record('parallel-tab-answer-refuses-stale-accept', f);
    await js(`document.documentElement.dataset.freeze='false'`); await open(f, 1440);
    assert.match((await ui()).text, /Hide it for an hour/);
    await clickLast('[data-action=accept]');
    await until('accepted', () => f.step().status === 'done');
    assert.equal(f.step().accepted.by, 'user');
    await until('the next step starts', () => f.step('Q2').status !== 'pending', 300);
    await record('accept-then-next-step-starts', f);
  }

  // ---- 2. The viewer: the same hold, the decisions sheet with the picture's first, save from the sheet; Back.
  {
    const f = P.view;
    await open(f, 492);
    await until('three open decisions', async () => (await ui()).count === '0 of 3 answered');
    await choose('D2', 1); await save('D2');
    await until('D2 saved', async () => (await ui()).count === '1 of 3 answered');
    await choose('D3', 1); // chosen, not saved
    assert.equal(await browser.click({ selector: "img[alt='A: one list']" }), true); await sleep(800);
    let u = await ui();
    assert.equal(u.accept.text, 'Accept the step'); assert.equal(u.accept.disabled, true);
    assert.match(u.hold, /2 decisions open: D1, D3/, 'the viewer says the same as the panel');
    await browser.click({ selector: '[data-action=decisions]' }); await sleep(400);
    const order = await js(`[...document.querySelectorAll('[data-decision]')].map(e => e.dataset.decision)`);
    assert.equal(order[0], 'D1', 'the decision about the shown picture first');
    assert.deepEqual((await ui()).chosen, ['D3:Yes, in WT2'], 'the panel\'s unsaved choice is the same in the viewer');
    await choose('D1', 2); await save('D1');
    await until('D1 saved from the viewer', () => answers(f, 'D1').length === 1);
    await geometry('viewer@492');
    await record('viewer-shows-the-same-hold-and-saves-from-the-sheet', f);
    await js('history.back()'); await sleep(800);
    u = await ui();
    assert.equal(await js(`!!document.querySelector("img[alt='A: one list']") && !document.querySelector('[data-action=decisions]')`), true, 'Back closed the viewer');
    assert.deepEqual(u.chosen, ['D3:Yes, in WT2'], 'Back keeps the unsaved choice on the page');
    assert.equal(u.accept.disabled, true); assert.match(u.hold, /1 decision open \(D3\)/);
    await record('back-from-viewer-keeps-the-page', f);
    // A reload shows what was saved, never an unsaved choice.
    await open(f, 492);
    u = await ui();
    assert.deepEqual(u.chosen, []); assert.equal(u.count, '2 of 3 answered');
    await record('reload-shows-only-saved-answers', f);
  }

  // ---- 3. Save failures, a double click, another project, a new version, an option asking for a change; phone.
  {
    const f = P.fail;
    await open(f, 390);
    await choose('D1', 1); await browser.type('A reads faster', `${card('D1')} textarea`);
    await js(`document.documentElement.dataset.fail='true'`); await save('D1');
    await until('the failure shows', async () => (await ui()).alerts.some(a => a.includes('Not saved: Simulated save failure')));
    let u = await ui();
    assert.deepEqual(u.chosen, ['D1:A: one list, oldest first'], 'a failed save keeps the choice'); assert.equal(u.count, '0 of 3 answered', 'and shows no success');
    assert.equal(answers(f, 'D1').length, 0); assert.doesNotMatch(u.text, /✓ Saved/);
    await record('failed-save-shows-no-success', f);
    await js(`document.documentElement.dataset.fail='false'; document.documentElement.dataset.delay='700'`);
    const before = (await requests()).length;
    await js(`(() => { const b = document.querySelector("${card('D1')} [data-action=save]"); b.click(); b.click(); })()`);
    await until('D1 saved', () => answers(f, 'D1').length === 1); await sleep(800);
    assert.equal((await requests()).length, before + 1, 'a double click saves once');
    assert.equal(answers(f, 'D1')[0].text, 'A reads faster');
    await js(`document.documentElement.dataset.delay='0'`);
    await record('slow-save-double-click-saves-once', f);
    // The same ids in another project start empty.
    await choose('D2', 1);
    await open(P.other, 390);
    assert.deepEqual((await ui()).chosen, [], 'another project shows no choice of this one');
    await open(f, 390);
    assert.deepEqual((await ui()).chosen, [], 'a reload drops the unsaved choice');
    // A new version while the page shows the old one: the save is refused, the old choice is not carried over.
    await js(`document.documentElement.dataset.freeze='true'`);
    await choose('D2', 2);
    // The material path: a picture added under the key D1 names makes D1's version 2 (D1 was answered).
    const p = png(join(f.root, 'list-c.png'));
    f.emit(f.worker, { type: 'review.added', step: 'Q1', round: 1, items: [{ path: p, label: 'C', kind: 'image', key: 'list@1440', role: 'result' }] });
    assert.equal(f.step().decisions.items.find(d => d.id === 'D1').version, 2, 'D1 has a new version');
    assert.equal(await clickLast("[aria-label='Change the answer to D1']"), true, 'Change opens the saved D1');
    await choose('D1', 2); await save('D1');
    await until('the version refusal shows', async () => (await ui()).alerts.some(a => /changed since you read it/.test(a)));
    assert.equal(answers(f, 'D1').length, 1, 'nothing saved for the old version');
    await js(`document.documentElement.dataset.freeze='false'`); await open(f, 390);
    await until('D1 at its new version', async () => /You answered an earlier version/.test((await ui()).text));
    u = await ui();
    assert.equal(u.chosen.some(c => c.startsWith('D1')), false, 'the old version\'s choice is not carried over');
    assert.match(u.text, /You answered an earlier version \(A: one list, oldest first\); the question changed/);
    await record('new-version-refuses-the-stale-save-and-drops-the-draft', f);
    // D3: a long question and option fit; the option asking a change holds Accept with its reason.
    await geometry('long-decision@390');
    await choose('D3', 2); await save('D3');
    await until('D3 saved', () => answers(f, 'D3').length === 1);
    await until('the page shows D3 asking a change', async () => (await ui()).holdKind === 'fix');
    u = await ui();
    assert.equal(u.holdKind, 'fix'); assert.match(u.hold, /Your answer to D3 asks for a change: Fix it sends your answers to the worker/);
    assert.equal(u.accept.disabled, true);
    await record('fix-option-holds-accept-with-its-reason', f);
    // Fix it with partial answers: sent back.
    await browser.click({ selector: '[data-action=fix]' });
    await browser.type('Collapse the groups, as D3 says.', "textarea[placeholder='What you want instead…']");
    await browser.click('Fix it');
    await until('the override confirmation', () => js(`document.body.innerText.includes('Send it back')`));
    await browser.click('Send it back');
    await until('sent back', () => f.step().status !== 'review');
    await record('fix-with-partial-answers-sends-back', f);
  }

  // ---- 4. Fix it and Reject with no answer at all.
  {
    const f = P.fix0;
    await open(f, 390);
    assert.equal((await ui()).accept.disabled, true);
    await browser.click({ selector: '[data-action=fix]' });
    await browser.type('Draw B with the queue name above each group.', "textarea[placeholder='What you want instead…']");
    await geometry('fix-without-answers@390');
    await browser.click('Fix it'); await until('confirm', () => js(`document.body.innerText.includes('Send it back')`)); await browser.click('Send it back');
    await until('sent back', () => f.step().status !== 'review');
    assert.ok(f.step().timeline.some(e => e.type === 'review.sent_back'));
    await record('fix-without-any-answer', f);
    const r = P.reject;
    await open(r, 1440);
    assert.equal(await browser.click({ selector: '[aria-haspopup=menu]' }), true, 'the ⋯ menu');
    assert.equal(await browser.click('Reject…'), true, 'Reject… in the menu');
    await browser.type('Not this design.', "textarea[placeholder='Why (optional)…']");
    await browser.click('Reject the step');
    await until('rejected', () => r.step().status === 'rejected');
    await record('reject-without-any-answer', r);
  }

  // ---- 5. A send-back's new round: answers are history, "Same as round 1" saves again, no draft carried over.
  {
    const f = P.round;
    await open(f, 1440);
    await choose('D1', 2); await save('D1');
    await until('D1 saved', () => answers(f, 'D1').length === 1);
    await choose('D2', 1); // unsaved
    await browser.click({ selector: '[data-action=fix]' });
    await browser.type('Group by queue, but keep the oldest first inside each group.', "textarea[placeholder='What you want instead…']");
    await browser.click('Fix it'); await until('confirm', () => js(`document.body.innerText.includes('Send it back')`)); await browser.click('Send it back');
    await until('round 2 in review', () => f.step().status === 'review' && f.step().timeline.filter(e => e.type === 'step.done').length === 2, 400);
    await open(f, 1440);
    await until('a new round opens every decision again', async () => (await ui()).count === '0 of 3 answered');
    let u = await ui();
    assert.deepEqual(u.chosen, [], 'no choice of round 1 is carried over');
    assert.match(u.text, /Round 1: you chose B: grouped by queue/);
    await browser.click('Same as round 1: B: grouped by queue');
    await until('saved again', () => answers(f, 'D1').some(a => a.round === 2));
    await until('the page shows D1 saved again', async () => (await ui()).count === '1 of 3 answered');
    u = await ui();
    assert.equal(u.count, '1 of 3 answered');
    await record('send-back-round-history-and-same-as-round-1', f);
  }

  // ---- 6. After away mode: the orchestrator's proposal is the user's to adopt; then the return batch.
  {
    const f = P.away;
    await open(f, 1440);
    await until('the proposal of the orchestrator on D1', async () => (await ui()).states.D1 === 'proposal');
    let u = await ui(); assert.match(u.text, /The orchestrator's proposal; it counts once it is your answer/);
    await choose('D2', 2); await save('D2'); await until('D2', () => answers(f, 'D2').length === 1);
    await choose('D3', 2); await save('D3'); await until('D3', () => answers(f, 'D3').length === 1);
    await until('the page shows D2 and D3 saved', async () => (await ui()).holdKind === 'proposal');
    u = await ui();
    assert.equal(u.holdKind, 'proposal'); assert.match(u.hold, /D1: the orchestrator's answer is a proposal/); assert.equal(u.accept.disabled, true);
    await browser.click('Use this answer');
    await until('adopted', () => answers(f, 'D1').at(-1).by === 'user');
    assert.equal(answers(f, 'D1').at(-1).choice, 'B: grouped by queue');
    await until('the page shows D1 adopted', async () => (await ui()).accept?.disabled === false);
    u = await ui(); assert.equal(u.accept.disabled, false);
    await clickLast('[data-action=accept]');
    await until('accepted', () => f.step().status === 'done');
    await record('away-proposal-adopted-then-accepted', f);
  }
  {
    const f = P.batch;
    await open(f, 1440, '');
    let u = await ui();
    assert.match(u.text, /2 provisional acceptances wait for your confirmation/);
    for (const d of ['D1', 'D2', 'D3']) assert.match(u.text, new RegExp(`Reason ${d}`));
    assert.match(u.text, /while you were away · provisional/);
    assert.match(u.text, /No decisions: “builds what Q1 chose”/);
    await browser.click({ selector: "[data-batch-decision='D1'] button" });
    await sleep(300);
    const fixText = await js(`document.querySelector("[data-batch-step='Q/Q1'] textarea")?.value`);
    assert.equal(fixText, 'D1: I choose “A: one list, oldest first” instead of “B: grouped by queue” (the orchestrator\'s choice).');
    await browser.click('Cancel');
    // Confirm all after another tab confirmed one: nothing is confirmed, the refusal shows; then each by itself.
    await browser.click('Confirm all 2…'); await sleep(300);
    u = await ui();
    assert.match(u.text, /Confirm these 2 steps, with the orchestrator's answers to your decisions/);
    assert.match(u.text, /D1: B: grouped by queue · D2: Hide it until it changes · D3: Later, in a queue of its own/);
    assert.equal((await post(f, '/queues/Q/steps/Q1/confirm', {})).status, 200);
    await browser.click('Confirm all 2');
    await until('the refusal', async () => (await ui()).alerts.length > 0 || !(await ui()).text.includes('Confirm all 2'));
    assert.equal(f.step('Q2').provisional.confirmed, undefined, 'all or nothing');
    await record('confirm-all-refused-after-another-tab', f);
    const g = P.batch2;
    await open(g, 1440, '');
    await browser.click('Confirm all 2…'); await sleep(300); await browser.click('Confirm all 2');
    await until('both confirmed', () => g.step('Q1').provisional?.confirmed && g.step('Q2').provisional?.confirmed);
    await record('confirm-all-confirms-both', g);
  }

  // ---- 7. Layout faults: the review and the return batch at every width, the outer boxes (the cards), the inner ones
  // (options, words, Save) and the action bar's each as a set (a box inside another is no fault: they are measured
  // apart), in a window tall enough that nothing scrolls under the action bar.
  const sets = {
    outer: '[data-decision], [data-batch-step], [data-decisions=missing]',
    inner: '[data-decision] [role=radio], [data-decision] textarea, [data-decision] [data-action], [data-batch-decision]',
    bar: '[data-action=accept], [data-action=fix], [aria-haspopup=menu], [data-accept-hold]',
  };
  const faults = [];
  for (const width of [1440, 492, 390]) {
    for (const [name, url] of [['review', `${inst.url}/#/${P.view.id}/Q/Q1`], ['review-long', `${inst.url}/#/${P.other.id}/Q/Q1`], ['return', `${inst.url}/#/${P.batch.id}`]]) {
      for (const [set, boxes] of Object.entries(sets)) {
        const r = await layout(`${name}-${set}`, url, width, boxes);
        faults.push({ name, set, width, exit: r.code, report: r.output.trim().split(/\r?\n/) });
      }
    }
  }
  writeFileSync(join(out, 'layout-summary.json'), JSON.stringify(faults, null, 2));
  console.log('All review-decision browser regressions passed. Evidence:', out);
} finally { await browser?.close(); await inst?.stop(); }
