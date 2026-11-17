// IC5 browser regressions and capture/layout evidence, on disposable fake-runtime projects only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProjectStore, type IdeaHandoff, type SessionFile } from "@nexus/protocol";
import { EdgeBrowser, profileDir } from "./capture/edge.ts";
import { collector, describe, findFaults, type Page } from "./capture/faults.ts";
import { captureViews, freePort, startInstance, type Instance } from "./capture/run.ts";
import { instanceEnv, parseViews } from "./capture/views.ts";

const root = resolve("."), temp = mkdtempSync(join(tmpdir(), "nexus-ideas-onward-"));
const out = resolve(process.argv[2] ?? join(tmpdir(), "nexus-review/IC/IC5"));
assert(!out.startsWith(root), "review material belongs outside the checkout"); mkdirSync(out, { recursive: true });
const log: string[] = [], record = (s: string) => { log.push(s); console.log(s); };
let browser: EdgeBrowser | undefined, instance: Instance | undefined;
try {
  browser = await EdgeBrowser.launch(profileDir(temp, "browser")); const b = browser;
  const until = async (name: string, predicate: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise((r) => setTimeout(r, 100)); }
    throw new Error(`Timed out: ${name}`);
  };
  const exists = (selector: string) => b.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`);
  const click = (label: string | { selector: string }) => until(`click ${JSON.stringify(label)}`, () => b.click(label));
  const fill = async (selector: string, value: string) => { await until(selector, () => exists(selector)); assert(await b.type(value, selector)); };
  const back = async (selector: string) => { await b.evaluate("history.back(); true"); await until(`Back ${selector}`, () => exists(selector)); };
  const reload = async (selector: string) => {
    await b.evaluate("window.ic5BeforeReload = true; location.reload(); true");
    await until("new document", () => b.evaluate<boolean>(`!window.ic5BeforeReload && document.readyState === 'complete' && !!document.querySelector(${JSON.stringify(selector)})`).catch(() => false));
  };
  for (const [scene, file] of [["entry", "ideas-onward-entry.yaml"], ["handoff", "ideas-handoff.yaml"]]) {
    const home = join(temp, scene!, "home"), data = join(temp, scene!, "data");
    mkdirSync(home, { recursive: true }); mkdirSync(data, { recursive: true });
    const list = parseViews(readFileSync(join(root, "scripts/capture/examples", file!), "utf8")), port = await freePort();
    const seed = spawnSync(process.execPath, [join(root, list.seed!), data], { cwd: root, encoding: "utf8", windowsHide: true,
      env: instanceEnv(process.env, { home, port, fakes: { claude: "", codex: "" } }) });
    assert.equal(seed.status, 0, seed.stderr || seed.stdout);
    instance = await startInstance({ root, home, port });
    const scripts = new Map(list.views.map((v) => [v.script!, readFileSync(v.script!, "utf8")]));
    for (const view of list.views) {
      const shots = await captureViews([view], b, { base: instance.url, out, side: "after", scripts });
      assert(!shots[0]!.error, shots[0]!.error);
      const faults = findFaults(await b.evaluate<Page>(collector("[data-box]", "[data-edge]")));
      record(`${view.key}: ${describe(faults).join("; ")}`);
      assert.equal(faults.through.length + faults.overlaps.length + faults.cut.length, 0, JSON.stringify(faults));
      if (view.key.startsWith("ideas-entry-open")) assert(await b.evaluate<boolean>("document.querySelector('[data-idea-open]').getBoundingClientRect().bottom < innerHeight && !document.querySelector('[data-related-work]').open"));
    }
    await instance.stop(); instance = undefined;
  }
  const home = join(temp, "regression/home"), data = join(temp, "regression/data"), fakeLog = join(temp, "fake.log");
  mkdirSync(home, { recursive: true }); mkdirSync(data, { recursive: true });
  const port = await freePort(), env = { ...process.env, FAKE_LOG: fakeLog };
  const seed = spawnSync(process.execPath, [join(root, "scripts/capture/seed-ideas-handoff.ts"), data], { cwd: root, encoding: "utf8", windowsHide: true,
    env: instanceEnv(env, { home, port, fakes: { claude: "", codex: "" } }) });
  assert.equal(seed.status, 0, seed.stderr || seed.stdout);
  instance = await startInstance({ root, home, port, parentEnv: env });
  const store = new ProjectStore(join(data, "demo/.nexus")), note = join(data, "demo/docs/ideas/chat-improvements.md");
  const original = readFileSync(note, "utf8"), queues = new Map(store.queueIds().map((id) => [id, readFileSync(join(store.dir, `queues/${id}/queue.yaml`), "utf8")]));
  const conversations = async () => await (await fetch(`${instance!.url}/api/projects/demo/conversations`)).json() as SessionFile[];
  const ownChats = async () => (await conversations()).filter((c) => c.about?.idea?.file === "docs/ideas/chat-improvements.md");
  const handoffs = () => store.readIdeaHandoffs().records;
  await b.open(`${instance.url}/#/demo`, 1440, 900);
  await b.evaluate("sessionStorage.clear(); true"); await click("Ideas"); await click("Overview");
  await fill('input[aria-label="Filter notes…"]', "Chat improvements"); await click("Chat improvements");
  assert.equal((await ownChats()).length, 0);
  await click({ selector: "[data-note-actions] button:last-child" });
  await until("preview ready", () => exists("[data-handoff-payload]"));
  assert.deepEqual(await b.evaluate<boolean[]>("[...document.querySelectorAll('[data-idea-handoff] input[type=checkbox]')].map(e => e.checked)"), [true, false]);
  assert(await b.evaluate<boolean>("document.querySelectorAll('[data-idea-handoff] input[type=checkbox]')[1].disabled"));
  await fill("[data-idea-handoff] textarea", "Discuss only; do not start anything."); await click("Refresh preview");
  await until("instruction in exact payload", () => b.evaluate<boolean>("document.querySelector('[data-handoff-payload]').textContent.includes('Discuss only; do not start anything.')"));
  writeFileSync(note, original.replace("Tools for the chats", "Updated summary for the chats"));
  await until("stale preview visible", () => b.evaluate<boolean>("document.body.innerText.includes('Review a refreshed preview')"));
  await click("Refresh preview");
  await until("fresh payload", () => b.evaluate<boolean>("document.querySelector('[data-handoff-payload]').textContent.includes('Updated summary')"));
  await b.evaluate(`(() => { const real = window.fetch; window.fetch = async (...args) => {
    const r = await real(...args); if (String(args[0]).endsWith('/ideas/handoffs') && args[1]?.method === 'POST') { window.fetch = real; throw new Error('Simulated lost handoff response'); } return r;
  }; return true; })()`);
  await click("Send to orchestrator");
  await until("lost reply visible", () => b.evaluate<boolean>("document.body.innerText.includes('Simulated lost handoff response')"));
  assert.equal(handoffs().length, 1); assert.equal(handoffs()[0]!.state, "delivered");
  assert.equal((await ownChats()).length, 0, "direct handoff needs no chat");
  await reload("[data-idea-handoff]"); await click("Retry the same save");
  await until("durable success visible", () => b.evaluate<boolean>("document.body.innerText.includes('Delivered to orchestrator')"));
  const handed = handoffs()[0] as IdeaHandoff;
  assert.equal(handoffs().length, 1); assert.doesNotMatch(handed.payload, /Quoting a selection/);
  assert.match(handed.payload, /2026-11-15/); assert.match(handed.payload, /Not decided — Open/);
  writeFileSync(join(out, "handoff-payload.txt"), handed.payload);
  await instance.stop(); instance = await startInstance({ root, home, port, parentEnv: env });
  await reload("[data-idea-handoff]"); await click("Cancel"); await until("note returned", () => exists("[data-idea-note]"));
  await click("Conversations and handoff history");
  // Opening the note mounts two asynchronous history queries; wait for the rendered receipt, not just its summary.
  await until("delivered history after restart", () => b.evaluate<boolean>("document.querySelector('[data-idea-activity]').innerText.includes('Delivered to orchestrator')"));
  record("PASS: chat-free handoff, exact date/default full exclusion, stale preview, lost response, reload and server restart keep one delivery");
  // Lose the creation response too: reload and retry must open the already-created, empty conversation.
  await b.evaluate(`(() => { const real = window.fetch; window.fetch = async (...args) => {
    const r = await real(...args); if (String(args[0]).endsWith('/conversations') && args[1]?.method === 'POST') { window.fetch = real; throw new Error('Simulated lost creation response'); } return r;
  }; return true; })()`);
  await click({ selector: "[data-note-actions] button:first-child" });
  await until("creation error visible", () => b.evaluate<boolean>("document.body.innerText.includes('Simulated lost creation response')"));
  assert.equal((await ownChats()).length, 1);
  await reload("[data-idea-note]"); await click({ selector: "[data-note-actions] button:first-child" });
  await until("empty idea chat", () => exists("[data-chat-scroll]"));
  assert.equal((await ownChats()).length, 1); const first = (await ownChats())[0]!;
  assert.equal(store.readChat(first.id).entries.length, 0); assert.equal(store.readRuntime(first.id), undefined);
  await back("[data-idea-note]"); await click({ selector: "[data-note-actions] button:first-child" });
  await until("another chat", async () => (await ownChats()).length === 2);
  await until("another chat rendered", () => exists("[data-chat-scroll]"));
  await back("[data-idea-note]");
  await click({ selector: '[data-decision="docs/ideas/chat-improvements.md#2026-11-15"] [data-idea-actions] button:first-child' });
  await until("dated chat", () => b.evaluate<boolean>("document.body.innerText.includes('Idea context · docs/ideas/chat-improvements.md#2026-11-15')"));
  const scoped = (await ownChats()).find((c) => c.about?.idea?.date === "2026-11-15")!;
  await fill("textarea", "First scoped browser request"); await click("Send");
  await until("first reply", async () => store.readChat(scoped.id).entries.some((c) => c.from === "partner"));
  const fakeText = () => existsSync(fakeLog) ? readFileSync(fakeLog, "utf8") : "";
  assert.match(fakeText(), /Updated summary for the chats/);
  writeFileSync(note, readFileSync(note, "utf8").replace("Pictures in the chats by pasting or dragging", "Changed selected decision"));
  await fill("textarea", "Second scoped browser request"); await click("Send");
  await until("fresh context reaches partner", async () => fakeText().includes("Changed selected decision"));
  rmSync(note);
  await until("missing note warning", () => b.evaluate<boolean>("document.body.innerText.includes('The idea note is missing')"));
  assert(store.readChat(scoped.id).entries.length > 0, "existing chat stays readable");
  writeFileSync(note, original);
  await back("[data-idea-note]"); await back("[data-ideas-overview]");
  assert.equal(await b.evaluate<string>("document.querySelector('input[aria-label=\"Filter notes…\"]').value"), "Chat improvements");
  record("PASS: always-new chat, lost creation response/reload idempotence, empty model-free open, exact dated scope, changed and missing context, Back retains overview filter");
  for (const [id, bytes] of queues) assert.equal(readFileSync(join(store.dir, `queues/${id}/queue.yaml`), "utf8"), bytes);
  record("All browser regressions passed. Queue bytes are unchanged; no real project, runtime or start permission was used.");
} catch (e) {
  record(`FAIL: ${e instanceof Error ? e.stack : e}`); await browser?.shot(join(out, "failure.png")); throw e;
} finally {
  await browser?.close(); await instance?.stop();
  writeFileSync(join(out, "verification.txt"), log.join("\n") + "\n");
  rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
}
