// The user's away mode (PROTOCOL.md, "Away mode"), against the fake `claude`: while it is on, level-2 steps are reviewed
// as level 3 and level-1 steps are not; when its time comes it ends; a queue that waits for the user meanwhile brings
// the orchestrator a list of the approved queues that can really start (none in the same checkout); agents cannot
// switch it; and a real server (a development instance on a free port, its own NEXUS_HOME) keeps it across a restart
// and ends it at its time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { ProjectStore, applyDraft, approveQueue, expireAway, loadProjectState, readAway, routeAnswers, turnAway, writeAway } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { spawnServer } from "./helpers.ts";
import { WAIT_MS, until as waitUntil, serverUp, LONGER } from "./wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");
const CLI = join(here, "../../../packages/cli/bin/nexus.js");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The user turns away mode on until `until` (ISO), or off: what the server's POST /api/server/away writes. */
const away = (until: string | null) => writeAway(turnAway(readAway(), until));
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-away-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_LOG = join(root, "fake.log");
  delete process.env.FAKE_REVIEW_ACCEPT;
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  let orchestrator: Orchestrator;
  const engine: Engine = new Engine(store, () => tick());
  orchestrator = new Orchestrator(store, engine, () => tick());
  function tick() { routeAnswers(store); orchestrator.onChange(loadProjectState(store)); engine.onChange(loadProjectState(store)); }
  const timer = setInterval(tick, 150);
  const state = () => loadProjectState(store);
  const queue = (q: string) => state().queues.find((x) => x.id === q)!;
  const step = (q: string, s: string) => queue(q).steps.find((x) => x.id === s)!;
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms, () => `; chat: ${JSON.stringify(orchestrator.view().chat.slice(-4))}`);
  const said = (re: RegExp) => orchestrator.view().chat.some((c) => re.test(c.text));
  const delivered = () => existsSync(process.env.FAKE_LOG!)
    ? readFileSync(process.env.FAKE_LOG!, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { text: string }).text) : [];
  const hello = async () => { orchestrator.say("Hello"); await until("the session", () => !!orchestrator.session()); };
  /** A queue whose steps have the given levels (FAKE: done each), approved; `worktree`: a checkout of its own. */
  const queueOf = (id: string, levels: (1 | 2 | 3)[], worktree?: string) => {
    if (worktree) mkdirSync(worktree, { recursive: true });
    applyDraft(store, { id, title: `Queue ${id}`, ...(worktree ? { worktree } : {}), steps: levels.map((level, i) => ({ id: `${id}${i + 1}`, title: `Step ${i + 1}`, goal: "FAKE: done", acceptance: [], review: { level } })) });
    approveQueue(store, id);
  };
  const inReview = (q: string, s: string, by: "orchestrator" | "user" = "orchestrator") => until(`${s} in review (${by})`, () => step(q, s).status === "review" && step(q, s).review_with === by, LONGER.step);
  const say = (...args: string[]) => orchestrator.say(`FAKE-NEXUS: ${JSON.stringify(args)}`);
  const stop = () => { clearInterval(timer); engine.shutdown(); orchestrator.shutdown(); };
  return { root, store, engine, orchestrator, state, queue, step, until, said, delivered, hello, queueOf, inReview, say, tick, stop };
}

test("away mode: level 2 runs as level 3 and level 1 still waits for the user; when its time comes, level 2 is itself again", async () => {
  const x = setup();
  try {
    await x.hello();
    away(inMs(3_600_000));
    await x.until("told that the user is away", () => x.said(/^The user is away until/));
    x.queueOf("A", [2, 1, 2]);
    x.engine.start("A");
    await x.inReview("A", "A1");
    await x.until("the review notice", () => x.delivered().some((t) => t.includes("Step A1 of queue A is done")));
    assert.match(x.delivered().find((t) => t.includes("Step A1 of queue A is done"))!, /Review level 3 \(level 2, reviewed as 3 while the user is away\)/);
    x.say("review", "provisional", "A", "A1", "--note", "The wording is yours.");
    await x.inReview("A", "A2", "user"); // level 1: the user's, away or not
    assert.equal(x.step("A", "A1").provisional?.text, "The wording is yours.", "level 2 accepted provisionally while away");
    assert.equal(x.queue("A").status, "waiting");
    assert.ok(x.state().attention.some((a) => a.kind === "review" && a.step === "A2"));

    // Its time comes: its end is moved to now rather than waited for (a real 8 s ran out before the run got here on a
    // busy machine, queue TS1); then the server records the end, here as its timer would.
    away(new Date().toISOString()); // after everything above: what happened then stays in the period
    await x.until("the end of away mode", () => !x.state().away.on);
    writeAway(expireAway(readAway()));
    x.tick();
    await x.until("told that it ended", () => x.said(/^Away mode ended at its time\./));
    x.engine.acceptReview("A", "A2");
    await x.inReview("A", "A3");
    await x.until("the review notice of A3", () => x.delivered().some((t) => t.includes("Step A3 of queue A is done")));
    assert.doesNotMatch(x.delivered().find((t) => t.includes("Step A3 of queue A is done"))!, /Review level 3/);
    x.say("review", "provisional", "A", "A3");
    await x.until("the refusal", () => x.said(/at review level 2 and away mode is off/));
    assert.equal(x.step("A", "A3").status, "review");
    assert.ok(x.step("A", "A1").provisional, "what was accepted while away stays accepted");
  } finally { x.stop(); }
});

test("away mode: a queue waiting for the user brings a list of the approved queues that can start, none in its checkout", async () => {
  const x = setup();
  try {
    await x.hello();
    x.queueOf("S", [1]);                                  // waits for the user, in the project's checkout
    x.queueOf("B", [2]);                                  // approved, the same checkout: cannot start
    x.queueOf("C", [2], join(x.root, "..", `${Date.now()}-c`)); // approved, a checkout of its own: can start
    away(inMs(3_600_000));
    x.engine.start("S");
    await x.inReview("S", "S1", "user");
    await x.until("the notice", () => x.said(/^Queue S waits for the user at step S1 \(review level 1/));
    // The chat shows the notice before the orchestrator's process has it: wait for what is checked, its delivery.
    await x.until("the notice delivered", () => x.delivered().some((t) => t.includes("Queue S waits for the user at step S1")));
    const notice = x.delivered().find((t) => t.includes("Queue S waits for the user at step S1"))!;
    assert.match(notice, /Approved queues that can start now: C "Queue C"/);
    assert.doesNotMatch(notice, /\bB "Queue B"/, "not in the checkout S holds");

    // With C running too, nothing else can start: told so for the next wait.
    x.engine.start("C");
    await x.inReview("C", "C1");
    x.say("review", "ask-user", "C", "C1", "I cannot judge this.");
    await x.until("the second notice", () => x.said(/^Queue C waits for the user at step C1 \(you handed it to the user\)/));
    await x.until("the second notice delivered", () => x.delivered().some((t) => t.includes("Queue C waits for the user at step C1")));
    assert.match(x.delivered().find((t) => t.includes("Queue C waits for the user at step C1"))!, /no other approved queue can start now/);
  } finally { x.stop(); away(null); }
});

test("agents cannot switch away mode: the CLI refuses any agent session", () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-away-cli-"));
  const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_HOME: join(root, "home"), NEXUS_SESSION: "01AGENTSESSION", NEXUS_PORT: "1" };
  delete env.NEXUS_DIR;
  for (const args of [["on", "--until", "8:00"], ["off"]]) {
    let out = "";
    try { execFileSync(process.execPath, [CLI, "server", "away", ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
    catch (err) { out = String((err as { stderr?: string }).stderr); }
    assert.match(out, /only the user switches away mode/, args.join(" "));
  }
  assert.equal(existsSync(join(root, "home", "away.yaml")), false, "nothing written");
});

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

test("a real server keeps away mode across a restart, and ends it at its time", async () => {
  const base = mkdtempSync(join(tmpdir(), "nexus-away-server-"));
  const home = join(base, "home");
  process.env.NEXUS_HOME = home;
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const start = async (): Promise<ChildProcess> => {
    const child = spawnServer({ NEXUS_HOME: home, NEXUS_PORT: String(port), NEXUS_LOG: "", NEXUS_DIR: "", NEXUS_SESSION: "" });
    await serverUp(url + "/api/server"); return child;
    child.kill();
    throw new Error("the server did not come up");
  };
  const status = async () => ((await (await fetch(url + "/api/server")).json()) as { away: { on: boolean; until?: string } }).away;
  const set = (until: unknown) => fetch(url + "/api/server/away", { method: "POST", headers: { "content-type": "application/json", origin: url, "sec-fetch-site": "same-origin" }, body: JSON.stringify({ until }) });
  const gone = (c: ChildProcess) => new Promise((r) => { if (c.exitCode !== null) r(null); else c.on("exit", r); });
  let child = await start();
  try {
    assert.deepEqual(await status(), { on: false });
    const r = await set("25:00");
    assert.equal(r.status, 400, "not a time of day");
    const until = inMs(6_000);
    assert.equal((await set(until)).status, 200);
    assert.deepEqual(await status(), { on: true, since: readAway().current!.since, until });

    child.kill();
    await gone(child);
    child = await start();
    assert.deepEqual((await status()).until, until, "kept across the restart");

    await sleep(Date.parse(until) - Date.now() + 1500);
    assert.deepEqual(await status(), { on: false }, "ended at its time");
    const file = YAML.parse(readFileSync(join(home, "away.yaml"), "utf8")) as { current?: unknown; past: { why: string; ended: string }[] };
    assert.equal(file.current, undefined);
    assert.deepEqual([file.past.at(-1)!.why, file.past.at(-1)!.ended], ["expired", until]);
  } finally { child.kill(); await gone(child); }
});
