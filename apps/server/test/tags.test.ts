// The project's tag lists against the fake orchestrator (docs/protocol/stats.md, "Tags"): its proposal goes into the user's
// waiting list; until the user accepts it a draft that uses it is refused, afterwards it is accepted, and the
// orchestrator is told the decision. No agent can accept: there is no command for it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, acceptTagProposal, loadProjectState, routeAnswers } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { QUICK_ENGINE, WAIT_MS, until as waitUntil } from "./wait.ts";
import { inProcessRuntime } from "./in-process-runtime.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-tags-"));
  process.env.NEXUS_HOME = join(root, "home");
  delete process.env.FAKE_LOG;
  const store = ProjectStore.init(root, { id: "p", name: "P", root, orchestrator: { notify: true } });
  const tick = () => { routeAnswers(store); const s = loadProjectState(store); orchestrator.onChange(s); engine.onChange(s); };
  const engine = new Engine(store, tick, { spawn: inProcessRuntime(), ...QUICK_ENGINE, retryBaseMs: 30, usageMarginMs: 100 });
  const orchestrator = new Orchestrator(store, engine, tick, {}, { spawn: inProcessRuntime() });
  const timer = setInterval(tick, 150);
  const chat = () => orchestrator.view().chat.map((c) => c.text);
  const until = (what: string, pred: () => boolean, ms = WAIT_MS) => waitUntil(what, pred, ms, () => `; chat: ${JSON.stringify(chat().slice(-3))}`);
  const said = (re: RegExp) => chat().some((t) => re.test(t));
  const say = (...args: string[]) => orchestrator.say(`FAKE-NEXUS: ${JSON.stringify(args)}`);
  const stop = () => { clearInterval(timer); orchestrator.shutdown(); engine.shutdown(); };
  return { store, orchestrator, until, said, say, stop };
}

const DRAFT = `FAKE-DRAFT:
id: T
title: Terrain
steps:
  - id: T1
    title: Cliffs
    goal: Make cliffs.
    kind: code
    size: M
    origin: user
    area: terrain
`;

test("a proposed area waits for the user; a draft using it is refused until the user accepts it; no agent accepts", async () => {
  const x = setup();
  try {
    x.orchestrator.say("Hello");
    await x.until("the orchestrator's session", () => !!x.orchestrator.session());

    x.say("tags", "propose", "--area", "terrain", "--reason", "the cliffs and rivers");
    await x.until("the proposal applied", () => x.said(/^ok: your proposal \(new area terrain\) waits for the user's acceptance/m));
    const item = loadProjectState(x.store).attention.find((a) => a.kind === "tags");
    assert.equal(item?.text, "New area terrain: the cliffs and rivers", "the proposal is in the user's waiting list");
    const id = item!.tags!.id;

    x.orchestrator.say(DRAFT);
    await x.until("the draft refused", () => x.said(/nexus failed: .*step T1: area terrain is proposed and waits for the user's acceptance/m));
    assert.throws(() => x.store.readQueue("T"), "no queue was written");

    // The orchestrator cannot accept its own proposal: there is no command, and nothing changes.
    x.say("tags", "accept", id);
    await x.until("the refusal", () => x.said(/nexus failed: .*accepting or declining a tag proposal is the user's, in the dashboard/));
    assert.equal(x.store.readTags().proposals.length, 1, "the proposal still waits");
    assert.deepEqual(x.store.readTags().areas, []);

    // The user accepts it (the dashboard's action): the orchestrator is told, and the same draft goes through.
    acceptTagProposal(x.store, id);
    assert.equal(loadProjectState(x.store).attention.some((a) => a.kind === "tags"), false, "decided: no longer waiting");
    await x.until("told of the acceptance", () => x.said(/^The user accepted your tag proposal: area terrain is on the project's list\.$/));
    x.orchestrator.say(DRAFT);
    await x.until("the draft accepted", () => x.said(/^ok: queue T created as proposed/m));
    assert.deepEqual(loadProjectState(x.store).queues.find((q) => q.id === "T")!.steps[0]!.tags, { kind: "code", area: "terrain", size: "M", origin: "user" });

    // nexus tags lists it for the orchestrator.
    x.say("tags");
    await x.until("the list", () => x.said(/the project's areas: terrain/));
  } finally { x.stop(); }
});
