// Browser regressions and layout-faults for IC4, against disposable projects and fake runtimes only.
// Build the web app first, then: node scripts/verify-ideas-ui.ts [report directory outside the checkout]
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IdeasResponse } from "@nexus/protocol/ideas";
import { EdgeBrowser, profileDir } from "./capture/edge.ts";
import { collector, describe, findFaults, type Page } from "./capture/faults.ts";
import { captureViews, freePort, startInstance, type Instance } from "./capture/run.ts";
import { instanceEnv, parseViews } from "./capture/views.ts";

const root = resolve("."), temp = mkdtempSync(join(tmpdir(), "nexus-ideas-ui-"));
const out = resolve(process.argv[2] ?? join(tmpdir(), "nexus-review/IC/IC4/verification"));
assert(!out.startsWith(root), "review material belongs outside the checkout");
mkdirSync(out, { recursive: true });
const log: string[] = [];
const record = (s: string) => { console.log(s); log.push(s); };
const pause = () => new Promise((r) => setTimeout(r, 100));
let browser: EdgeBrowser | undefined, instance: Instance | undefined;
try {
  browser = await EdgeBrowser.launch(profileDir(temp, "regression"));
  const b = browser;
  const until = async (name: string, predicate: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) { if (await predicate()) return; await pause(); }
    throw new Error(`Timed out: ${name}`);
  };
  const visible = (selector: string) => b.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`);
  const click = async (text: string, scope = "body") => {
    await until(`button ${text}`, () => b.evaluate<boolean>(`(() => {
      const el = [...(document.querySelector(${JSON.stringify(scope)})?.querySelectorAll('button,summary,a') ?? [])].find(e => e.textContent.trim() === ${JSON.stringify(text)}) ?? [...(document.querySelector(${JSON.stringify(scope)})?.querySelectorAll('button,summary,a') ?? [])].find(e => e.textContent.trim().startsWith(${JSON.stringify(text)}));
      if (!el || el.disabled || !el.getClientRects().length) return false; el.scrollIntoView({block:'nearest'}); el.click(); return true;
    })()`));
  };
  const fill = async (selector: string, text: string) => { assert(await b.type(text, selector), `field ${selector}`); };
  const back = async () => { await b.evaluate("history.back(); true"); await new Promise((r) => setTimeout(r, 250)); };
  let data = "";
  for (const [scene, file] of [["baseline", "ideas-corrections.yaml"], ["corrections", "ideas-ui.yaml"]]) {
    const home = join(temp, scene!, "home"); data = join(temp, scene!, "data");
    mkdirSync(home, { recursive: true }); mkdirSync(data, { recursive: true });
    const list = parseViews(readFileSync(join(root, "scripts/capture/examples", file!), "utf8"));
    const port = await freePort();
    const seeded = spawnSync(process.execPath, [join(root, list.seed!), data], { cwd: root, encoding: "utf8", windowsHide: true,
      env: instanceEnv(process.env, { home, port, fakes: { claude: "", codex: "" } }) });
    assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);
    instance = await startInstance({ root, home, port });
    record(`${scene}: isolated fake-runtime server on ${instance.port}`);
    const scripts = new Map(list.views.flatMap((v) => v.script ? [[v.script, readFileSync(v.script, "utf8")] as const] : []));
    for (const view of list.views) {
      const shots = await captureViews([view], b, { base: instance.url, out, side: "after", scripts });
      assert(!shots[0]!.error, shots[0]!.error);
      const faults = findFaults(await b.evaluate<Page>(collector("[data-box]", "[data-edge]")));
      record(`${view.key}: ${describe(faults).join("; ")}`);
      assert.equal(faults.through.length + faults.overlaps.length + faults.cut.length, 0, JSON.stringify(faults));
      if (view.key.startsWith("ideas-entry-open")) {
        assert(await b.evaluate<boolean>(`(() => { const q = document.querySelector('[data-idea-open]').getBoundingClientRect(); return q.top > 0 && q.bottom < innerHeight && !document.querySelector('[data-related-work]').open; })()`), "Open visible initially, work collapsed");
      }
    }
    if (scene === "baseline") { await instance.stop(); instance = undefined; }
  }
  await instance!.stop(); instance = undefined;
  const home = join(temp, "regression/home"); data = join(temp, "regression/data");
  mkdirSync(home, { recursive: true }); mkdirSync(data, { recursive: true });
  const port = await freePort();
  const seed = spawnSync(process.execPath, [join(root, "scripts/capture/seed-ideas-ui.ts"), data], { cwd: root, encoding: "utf8", windowsHide: true,
    env: instanceEnv(process.env, { home, port, fakes: { claude: "", codex: "" } }) });
  assert.equal(seed.status, 0, seed.stderr || seed.stdout);
  instance = await startInstance({ root, home, port });
  const url = instance.url;
  const ideas = async () => await (await fetch(`${url}/api/projects/demo/ideas`)).json() as IdeasResponse;
  const reset = async () => {
    await b.open(`${url}/#/demo`, 1440, 900, readFileSync("scripts/capture/reset-ideas.js", "utf8"));
    await click("Ideas"); await click("Overview"); await until("overview", () => visible("[data-ideas-overview]"));
  };
  await reset();
  assert.equal((await ideas()).to_match.suggestions, 0);
  await click("Manage links"); await until("manager", () => visible("[data-ideas-matching]"));
  await back(); await click("Manage links");
  record("PASS: zero-pending manager can be opened, closed and reopened");
  const wrong = [
    ["MT", "docs/ideas/user-notes-2026-11-15.md#2026-11-15"],
    ["IO", "docs/ideas/tags.md#2026-11-14"],
    ["ST2", "docs/ideas/tags.md#2026-11-14"],
  ];
  const before = await ideas();
  const queueBytes = new Map(["MT", "IO", "ST2", "FB"].map((q) => [q, readFileSync(join(data, `demo/.nexus/queues/${q}/queue.yaml`), "utf8")]));
  const noteFile = join(data, "demo/docs/ideas/chat-improvements.md"), noteBytes = readFileSync(noteFile, "utf8");
  const origin = async (queue: string, ref: string) => (await ideas()).links.items.find((r) => r.queue === queue && r.ref === ref && r.origin === "match")!;
  const row = (id: string) => `[data-origin=${JSON.stringify(id)}]`;
  const saveLink = async (reason: string) => {
    await until("correction form", () => visible("[data-link-form]")); await fill("[data-link-form] textarea", reason);
    await click("Save correction", "[data-link-form]"); await until("saved correction", async () => !(await visible("[data-link-form]")));
  };
  const mt = await origin("MT", wrong[0]![1]!);
  await click("Change target", row(mt.id));
  await until("replacement form", () => visible("[data-link-form]"));
  await fill("[data-link-form] [data-decision-select]", "docs/ideas/queue-templates.md#2026-11-15");
  await saveLink("Replace the umbrella match with the exact maintenance decision.");
  assert(!(await origin("MT", mt.ref)).effective);
  assert((await ideas()).links.items.some((r) => r.queue === "MT" && r.ref === "docs/ideas/queue-templates.md#2026-11-15" && r.effective));
  await click("Correction history"); await click("Undo correction", "[data-link-history]"); await saveLink("Undo the atomic replacement before trying the separate four corrections.");
  assert((await origin("MT", mt.ref)).effective);
  assert(!(await ideas()).links.items.some((r) => r.queue === "MT" && r.ref === "docs/ideas/queue-templates.md#2026-11-15" && r.effective));
  record("PASS: atomic target replacement and its undo restore both origins");
  for (const [queue, ref] of wrong) {
    const item = await origin(queue!, ref!);
    await click("Remove link", row(item.id)); await saveLink(`${queue}: historical context does not establish implementation.`);
    assert(!(await origin(queue!, ref!)).effective);
  }
  await click("Add link"); await until("add", () => visible("[data-link-form]"));
  await fill("[data-link-form] input", "MT"); await fill("[data-link-form] select", "MT");
  await fill("[data-link-form] [data-decision-select]", "docs/ideas/queue-templates.md#2026-11-15");
  await saveLink("The notes-maintenance decision belongs to queue-templates, 15 November.");
  const corrected = await ideas();
  assert(corrected.links.items.some((r) => r.queue === "MT" && r.ref === "docs/ideas/queue-templates.md#2026-11-15" && r.effective));
  for (const item of before.links.items.filter((r) => r.effective && !wrong.some(([q, ref]) => q === r.queue && ref === r.ref))) {
    assert(corrected.links.items.some((r) => r.id === item.id && r.effective), `preserved ${item.id}`);
  }
  for (const [q, bytes] of queueBytes) assert.equal(readFileSync(join(data, `demo/.nexus/queues/${q}/queue.yaml`), "utf8"), bytes);
  assert.equal(readFileSync(noteFile, "utf8"), noteBytes);
  record("PASS: MT/IO/ST2 wrong matches removed; MT correct date added; other origins, queues and note bytes preserved");
  // Make explicit decisions from a legacy accepted match, then undo each through the visible history.
  const target = await origin("TG", "docs/ideas/tags.md#2026-11-14");
  for (const [button, decision] of [["Reject suggestion", false], ["Pending", null], ["Accept suggestion", true]] as const) {
    await click(button, row(target.id)); await saveLink(`Browser regression: ${button}`);
    assert.equal((await origin("TG", target.ref)).state, decision === null ? "pending" : decision ? "linked" : "rejected");
    if (decision === null) continue;
    if (!await b.evaluate<boolean>("document.querySelector('[data-link-history]').open")) await click("Correction history");
    await click("Undo correction", "[data-link-history]"); await saveLink(`Undo ${button}`);
  }
  await click("Reject suggestion", row(target.id)); await saveLink("Resolve the last pending suggestion.");
  assert.equal((await ideas()).to_match.suggestions, 0);
  await back(); await click("Manage links");
  record("PASS: accepted/rejected decisions undo; last pending decision reaches zero; manager reopens");
  // Commit succeeds but its response is lost: draft stays, retry reuses the same request and adds one history item.
  await b.evaluate(`(() => { const send = window.fetch; window.ic4Requests = []; let fail = true;
    window.fetch = async (...args) => { if (String(args[0]).endsWith('/ideas/links') && args[1]?.method === 'POST') {
      window.ic4Requests.push(JSON.parse(args[1].body)); const result = await send(...args);
      if (fail) { fail = false; throw new TypeError('Synthetic lost response'); } return result;
    } return send(...args); }; return true; })()`);
  const count = (await ideas()).links.history.length;
  await click("Accept suggestion", row(target.id)); await fill("[data-link-form] textarea", "Keep this draft after a lost response.");
  await click("Save correction", "[data-link-form]");
  await until("save error", () => b.evaluate<boolean>("document.querySelector('[data-link-form]')?.textContent.includes('Synthetic lost response') ?? false"));
  assert.equal(await b.evaluate("document.querySelector('[data-link-form] textarea').value"), "Keep this draft after a lost response.");
  await click("Retry the same save"); await until("retried", async () => !(await visible("[data-link-form]")));
  assert.equal((await ideas()).links.history.length, count + 1);
  const ids = await b.evaluate<string[]>("window.ic4Requests.map(r => r.request_id)"); assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
  record("PASS: lost save response preserves reason; retry uses same ID and produces one action");
  await back(); await click("Chat improvements");
  await until("note", () => visible("[data-idea-note]"));
  await click("Review implementation"); await until("status form", () => visible("[data-idea-status-form]"));
  await fill("[data-idea-status-form] select", "confirm");
  await fill("[data-idea-status-form] textarea", "Reviewed the entire changed date against CH2.");
  await click("Save decision", "[data-idea-status-form]"); await until("confirmed", () => visible("[data-idea-note]"));
  const date = "docs/ideas/chat-improvements.md#2026-11-14";
  assert.equal((await ideas()).statuses.entries.find((e) => e.ref === date)!.implementation, "full");
  assert.equal((await ideas()).statuses.entries.find((e) => e.ref.endsWith("chat-improvements.md#2026-11-15"))!.implementation, "unconfirmed");
  await click("Review implementation"); await until("new status form", () => visible("[data-idea-status-form]"));
  await fill("[data-idea-status-form] textarea", "Draft survives a concurrent edit.");
  writeFileSync(noteFile, noteBytes.replace("- Detail 2.", "- Detail 2: changed while the form is open."));
  await until("server observes change", async () => (await ideas()).statuses.entries.find((e) => e.ref === date)!.implementation === "needs_review");
  await until("visible stale draft", () => b.evaluate<boolean>("document.querySelector('[data-idea-status-form]')?.textContent.includes('Changed since') ?? false"));
  assert.equal(await b.evaluate("document.querySelector('[data-idea-status-form] textarea').value"), "Draft survives a concurrent edit.");
  await click("Refresh and review");
  await until("fresh revision", () => b.evaluate<boolean>("!document.querySelector('[data-idea-status-form]').textContent.includes('Changed since')"));
  await click("Cancel", "[data-idea-status-form]"); await until("back to note", () => visible("[data-idea-note]"));
  await b.evaluate("location.reload(); true"); await until("note after reload", () => visible("[data-idea-note]"));
  assert(await b.evaluate<boolean>("document.querySelector('[data-idea-note]').textContent.includes('Previously confirmed')"));
  await back(); await until("overview after Back", async () => !(await visible("[data-idea-note]")));
  record("PASS: dated confirmation, concurrent decision change, draft refresh, reload and Back preserve correct state");
  await instance.stop(); instance = undefined;
  const emptyHome = join(temp, "unmatched/home"), emptyData = join(temp, "unmatched/data");
  mkdirSync(emptyHome, { recursive: true }); mkdirSync(emptyData, { recursive: true });
  const unmatched = spawnSync(process.execPath, [join(root, "scripts/capture/seed-ideas-unmatched.ts"), emptyData], { cwd: root, encoding: "utf8", windowsHide: true,
    env: instanceEnv(process.env, { home: emptyHome, port, fakes: { claude: "", codex: "" } }) });
  assert.equal(unmatched.status, 0, unmatched.stderr || unmatched.stdout);
  instance = await startInstance({ root, home: emptyHome, port });
  await reset(); await click("Manage links"); await until("never-matched manager", () => visible("[data-ideas-matching]"));
  assert.equal((await ideas()).links.items.length, 0);
  await click("Add link"); await until("manual add without suggestions", () => visible("[data-link-form]"));
  await fill("[data-link-form] select", "Q"); await fill("[data-link-form] [data-decision-select]", "docs/ideas/choice.md#2026-11-15");
  await saveLink("First relationship, without an inferred suggestion.");
  assert.equal((await ideas()).links.items.filter((r) => r.effective).length, 1);
  record("PASS: never-matched, zero-suggestion project exposes manual add and persists its first link");
  record("All browser regressions passed; all 12 layouts have zero faults. No real project was read or written by this script.");
} catch (error) {
  record(`FAIL: ${error instanceof Error ? error.stack : error}`);
  await browser?.shot(join(out, "failure.png"));
  throw error;
} finally {
  await browser?.close(); await instance?.stop();
  writeFileSync(join(out, "verification.txt"), log.join("\n") + "\n");
  rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
}
