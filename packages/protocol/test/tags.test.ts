// Step tags (tags.ts; docs/protocol/stats.md, "Tags"): inheritance from the queue, the check of a draft against Nexus's lists and
// the project's, a project activity usable only once the user accepted it, one kind per step, renames read through,
// the hash of an approved queue without tags unchanged, and the tags in a TurnRecord.
import { errorText } from "../src/errors.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProjectStore, TurnRecord, acceptTagProposal, activityDifference, applyDraft, approveQueue, declineTagProposal, inheritedTags, isApproved, loadProjectState,
  proposeTags, renamedTag, revisionHash, stepTags, type QueueFile,
} from "../src/index.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-tags-"));
  process.env.NEXUS_HOME = join(root, "home");
  return ProjectStore.init(root, { id: "p", name: "P", root });
}

const step = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Step ${id}`, goal: "Do it.", ...extra });
const draft = (extra: Record<string, unknown>, steps: Record<string, unknown>[]) => ({ id: "Q", title: "Queue", ...extra, steps });
const refusal = (store: ProjectStore, def: unknown): string => {
  try { applyDraft(store, def); } catch (e) { return errorText(e); }
  assert.fail("the draft was accepted");
};

test("a step inherits each tag it does not set from its queue; its own activities replace the queue's", () => {
  const queue = { kind: "code", activities: ["feature"], size: "M" as const, origin: "user" };
  assert.deepEqual(inheritedTags({}, queue), queue);
  assert.deepEqual(inheritedTags({ kind: "docs", activities: ["test"] }, queue), { kind: "docs", activities: ["test"], size: "M", origin: "user" });
  assert.deepEqual(inheritedTags({}, {}), {});

  const store = setup();
  store.writeTags({ ...store.readTags(), areas: [{ name: "engine", at: "2026-11-15T00:00:00.000Z" }] });
  applyDraft(store, draft({ kind: "code", area: "engine", origin: "user" }, [step("Q1", { size: "S" }), step("Q2", { kind: "design", size: "L" })]));
  const q = loadProjectState(store).queues[0]!;
  assert.deepEqual(q.steps.find((s) => s.id === "Q1")!.tags, { kind: "code", area: "engine", size: "S", origin: "user" });
  assert.deepEqual(q.steps.find((s) => s.id === "Q2")!.tags, { kind: "design", area: "engine", size: "L", origin: "user" });
});

test("a name on no list is refused when drafted, with what to do instead", () => {
  const store = setup();
  assert.match(refusal(store, draft({}, [step("Q1", { kind: "coding" })])), /step Q1: kind coding is not one of Nexus's kinds \(mechanical, code, debugging, design, research, docs\)/);
  assert.match(refusal(store, draft({}, [step("Q1", { activities: ["frobnicate"] })])), /activity frobnicate is not one of Nexus's activities .*carries the project's prefix/);
  assert.match(refusal(store, draft({}, [step("Q1", { area: "engine" })])), /area engine is not in the project's list \(it has none yet\): propose it with nexus tags propose --area engine/);
  assert.match(refusal(store, draft({ origin: "boss" }, [step("Q1")])), /queue Q: origin boss is not one of Nexus's origins/);
  assert.match(refusal(store, draft({}, [step("Q1", { size: "XL" })])), /size/);
  // Nexus's own names need no list of the project's.
  applyDraft(store, draft({ kind: "code", origin: "orchestrator" }, [step("Q1", { activities: ["feature", "test"], size: "M" })]));
});

test("two kinds on a step are refused: exactly one, the dominant one", () => {
  const store = setup();
  assert.match(refusal(store, draft({}, [step("Q1", { kind: ["code", "docs"] })])), /a step has exactly one kind, the dominant one \(not code, docs\); what else it does goes into its activities/);
  assert.match(refusal(store, draft({}, [step("Q1", { kind: "code, docs" })])), /exactly one kind/);
  assert.match(refusal(store, draft({ kind: ["code", "design"] }, [step("Q1")])), /exactly one kind/);
});

test("a project's own activity is usable only once the user accepted it onto the list", () => {
  const store = setup();
  const def = draft({}, [step("Q1", { kind: "code", activities: ["hc:terrain"] })]);
  assert.match(refusal(store, def), /activity hc:terrain is not in the project's list: propose it with nexus tags propose --activity hc:terrain/);
  assert.match(proposeTags(store, { activity: "hc:terrain", reason: "terrain work" }), /waits for the user's acceptance/);
  assert.match(refusal(store, def), /activity hc:terrain is proposed and waits for the user's acceptance/);
  // The prefix is the project's: another one is refused, and so are Nexus's own names and bad forms.
  assert.throws(() => proposeTags(store, { activity: "xy:rivers" }), /carry its prefix hc/);
  assert.throws(() => proposeTags(store, { activity: "feature" }), /one of Nexus's activities/);
  assert.throws(() => proposeTags(store, { activity: "terrain" }), /prefix, a colon and a name/);
  assert.throws(() => proposeTags(store, { activity: "hc:terrain" }), /proposed already/);
  const id = store.readTags().proposals[0]!.id;
  assert.equal(acceptTagProposal(store, id), "activity hc:terrain is on the project's list");
  assert.equal(store.readTags().prefix, "hc", "the first accepted activity fixes the prefix");
  applyDraft(store, def);
  assert.deepEqual(loadProjectState(store).queues[0]!.steps[0]!.tags.activities, ["hc:terrain"]);
  // A declined proposal leaves the lists as they were.
  proposeTags(store, { area: "rivers" });
  declineTagProposal(store, store.readTags().proposals[0]!.id);
  assert.deepEqual([store.readTags().areas, store.readTags().decisions.map((d) => d.accepted)], [[], [true, false]]);
});

test("a rename reads the old name as the new one, and the old one is not used again", () => {
  const store = setup();
  proposeTags(store, { area: "engine" });
  acceptTagProposal(store, store.readTags().proposals[0]!.id);
  proposeTags(store, { activity: "hc:terrain" });
  acceptTagProposal(store, store.readTags().proposals[0]!.id);
  applyDraft(store, draft({ area: "engine" }, [step("Q1", { kind: "code", activities: ["hc:terrain", "feature"] })]));
  assert.throws(() => proposeTags(store, { rename: { from: "code", to: "coding" } }), /one of Nexus's own names/);
  proposeTags(store, { rename: { from: "engine", to: "core" }, reason: "clearer" });
  proposeTags(store, { rename: { from: "hc:terrain", to: "hc:ground" } });
  assert.deepEqual(loadProjectState(store).attention.filter((a) => a.kind === "tags").map((a) => a.text).sort(),
    ["Rename activity hc:terrain to hc:ground", "Rename area engine to core: clearer"]);
  for (const p of store.readTags().proposals) acceptTagProposal(store, p.id);

  const t = store.readTags();
  assert.deepEqual([t.areas.map((x) => x.name), t.activities.map((x) => x.name)], [["core"], ["hc:ground"]]);
  assert.equal(renamedTag("engine", t.renames), "core");
  assert.deepEqual(stepTags({ activities: ["hc:terrain"] }, { area: "engine" }, t), { activities: ["hc:ground"], area: "core" });
  // The queue file keeps the old names; every view reads them as the new ones.
  assert.equal(store.readQueue("Q").area, "engine");
  assert.deepEqual(loadProjectState(store).queues[0]!.steps[0]!.tags, { kind: "code", activities: ["hc:ground", "feature"], area: "core" });
  // A revision that leaves the tags as they were is not checked again; a new use of the old name is refused.
  applyDraft(store, draft({ area: "engine" }, [step("Q1", { kind: "code", activities: ["hc:terrain", "feature"] }), step("Q2", { kind: "docs" })]));
  assert.match(refusal(store, draft({ area: "engine" }, [step("Q1", { kind: "code", activities: ["hc:terrain", "feature"] }), step("Q2", { kind: "docs" }), step("Q3", { kind: "docs", area: "engine" })])),
    /step Q3: area engine was renamed to core: use the new name/);
  assert.throws(() => proposeTags(store, { area: "engine" }), /was renamed to core/);
  // A chain of renames reads through to the newest name.
  proposeTags(store, { rename: { from: "core", to: "kernel" } });
  acceptTagProposal(store, store.readTags().proposals[0]!.id);
  assert.equal(renamedTag("engine", store.readTags().renames), "kernel");
});

test("the hash of an approved queue without tags is what it was before tags; tags count once set", () => {
  const store = setup();
  const q: QueueFile = {
    protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: ["stop"], checks: ["npm test"],
    steps: [{ id: "Q1", title: "One", goal: "Do it.", acceptance: ["done"], review: { level: 2 } }],
    approvals: [], withdrawals: [], history: [], changes: [], coding: true,
  };
  // The formula before tags: steps, stop conditions, checks, and coding only when true.
  const before = "sha256:" + createHash("sha256").update(JSON.stringify({ steps: q.steps, stop_conditions: q.stop_conditions, checks: q.checks, coding: true })).digest("hex");
  assert.equal(revisionHash(q), before);
  store.writeQueue(q);
  const read = store.readQueue("Q");
  assert.equal(revisionHash(read), before, "read back from queue.yaml, the hash is the same");
  approveQueue(store, "Q");
  assert.ok(isApproved(store.readQueue("Q")));
  // Tags are part of what an approval pins, on the queue and on a step.
  assert.notEqual(revisionHash({ ...q, kind: "code" }), before);
  assert.notEqual(revisionHash({ ...q, steps: [{ ...q.steps[0]!, size: "S" }] }), before);
});

test("a TurnRecord carries the step's tags", () => {
  const r = TurnRecord.parse({
    v: 1, at: "2026-11-15T00:00:00.000Z", project: "p", session: "s", role: "worker", runtime: "claude", queue: "Q", step: "Q1",
    outcome: "ok", tags: { kind: "code", activities: ["feature"], area: "engine", size: "M", origin: "user" },
  });
  assert.deepEqual(r.tags, { kind: "code", activities: ["feature"], area: "engine", size: "M", origin: "user" });
  assert.equal(TurnRecord.parse({ ...r, tags: undefined }).tags, undefined, "a record without tags (older, or no step) still reads");
});

test("planned against observed activities: both, unplanned and skipped; over every round, renames read through", () => {
  assert.equal(activityDifference(["feature"], undefined), undefined, "nothing reported: nothing to compare");
  assert.deepEqual(activityDifference(["feature", "test"], ["feature", "refactor"]), { both: ["feature"], unplanned: ["refactor"], skipped: ["test"] });
  assert.deepEqual(activityDifference(undefined, ["docs-x"]), { both: [], unplanned: ["docs-x"], skipped: [] });

  const store = setup();
  const at = "2026-11-15T00:00:00.000Z";
  store.writeTags({ ...store.readTags(), prefix: "hc", activities: [{ name: "hc:ground", at }], renames: [{ from: "hc:terrain", to: "hc:ground", at }] });
  applyDraft(store, draft({ kind: "code" }, [step("Q1", { activities: ["feature", "test"] })]));
  store.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "claude", cwd: ".", launched_by: "nexus", created_at: at });
  const done = (min: number, activities: string[]) => {
    store.appendEvent({ v: 1, id: `s${min}`, at: `2026-11-15T00:0${min}:00.000Z`, session: "w", type: "step.started", queue: "Q", step: "Q1" });
    store.appendEvent({ v: 1, id: `d${min}`, at: `2026-11-15T00:0${min}:30.000Z`, session: "w", type: "step.done", queue: "Q", step: "Q1", summary: "s", activities });
  };
  done(1, ["feature", "hc:terrain"]);
  done(2, ["refactor", "feature"]); // a second round (a send-back) adds what it did
  const st = loadProjectState(store).queues[0]!.steps[0]!;
  assert.deepEqual(st.observed_activities, ["feature", "hc:ground", "refactor"]);
  assert.deepEqual(activityDifference(st.tags.activities, st.observed_activities), { both: ["feature"], unplanned: ["hc:ground", "refactor"], skipped: ["test"] });
});
