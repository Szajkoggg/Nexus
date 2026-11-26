// A seed for the capture tool: a test project "demo" whose plan holds queues that have run but do not work now (queue
// PVA, step PVA0: the user's report of 2026-11-18). Run by scripts/capture.ts as `node <this> <data dir>` with
// NEXUS_HOME set to the development instance's; it writes only there.
//
// RN runs (held "for an update", so the instance resumes it; its first step, FAKE: bglong, leaves background work
// running, so the run stays running while the pictures are taken). PA has run and is paused, and was planned after RN
// since; SB has run and stopped, and was planned after RN since; FR has run and is paused, with nothing it waits for.
// NX is planned after SB and has never run.
// It uses only what the protocol has had since queue PV1 (plan.yaml), so it also seeds the code of a base commit.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, newId, writeRegistry, type Event, type PlanFile, type SessionFile } from "@nexus/protocol";
import { requireTempHome } from "../temp-home.ts";

requireTempHome();

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-plan-started.ts <data dir>");
const root = join(dir, "demo");
mkdirSync(root, { recursive: true });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
// Each with its runtime's session id, so the instance can resume RN's run.
const session = (id: string, title: string, queue: string): SessionFile => {
  const s: SessionFile = { protocol: 1, id, project: "demo", role: "worker", runtime: "claude", native_id: randomUUID(), title, cwd: root, launched_by: "nexus", created_at: ago(300), queue };
  st.writeSession(s);
  return s;
};
const emit = (s: SessionFile, min: number, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session: s.id, ...body } as Event);
const queue = (id: string, title: string, steps: [string, string][]) => {
  st.writeQueue({ protocol: 1, id, title, revision: 1, status: "proposed", stop_conditions: [], checks: [],
    steps: steps.map(([sid, stitle]) => ({ id: sid, title: stitle, goal: "FAKE: done", acceptance: ["Done"] })) });
  approveQueue(st, id);
};
/** The plan of a queue: its predecessors, set by the user. */
const plan = (id: string, after: string[], min: number) => {
  const p: PlanFile = { protocol: 1, by: "user", created_at: ago(min), updated_at: ago(min), after: after.map((queue) => ({ queue, by: "user", at: ago(min) })), decisions: [] };
  st.writePlan(id, p);
  st.writeStart(id, { protocol: 1, by: "user", revision: st.readQueue(id).revision, created_at: ago(min) });
};

// At work.
const rn = session(newId(), "RN worker", "RN");
queue("RN", "Search in the docs", [["RN1", "Index the docs"], ["RN2", "Search box"]]);
st.writeQueue({ ...st.readQueue("RN"), steps: st.readQueue("RN").steps.map((s, i) => (i === 0 ? { ...s, goal: "FAKE: bglong" } : s)) });
approveQueue(st, "RN");
emit(rn, 30, { type: "step.started", queue: "RN", step: "RN1" });
st.writeRun("RN", { protocol: 1, session: rn.id, state: "paused", reason: "held for an update", resume_after_restart: true, step: "RN1", started_at: ago(30), updated_at: ago(1), runtime: "claude", revision: 1 });

// Paused after its first step, then planned after RN.
const pa = session(newId(), "PA worker", "PA");
queue("PA", "Cliff paths", [["PA1", "Path mesh"], ["PA2", "Railings"]]);
emit(pa, 120, { type: "step.started", queue: "PA", step: "PA1" });
emit(pa, 100, { type: "step.done", queue: "PA", step: "PA1", summary: "The path mesh follows the cliff." });
emit(pa, 99, { type: "step.started", queue: "PA", step: "PA2" });
st.writeRun("PA", { protocol: 1, session: pa.id, state: "paused", reason: "paused by the user", step: "PA2", started_at: ago(120), updated_at: ago(90), runtime: "claude", revision: 1 });
plan("PA", ["RN"], 60);

// Stopped at its first step, then planned after RN.
const sb = session(newId(), "SB worker", "SB");
queue("SB", "Sync to the cloud", [["SB1", "Upload"], ["SB2", "Conflicts"]]);
emit(sb, 200, { type: "step.started", queue: "SB", step: "SB1" });
emit(sb, 180, { type: "queue.stop", queue: "SB", step: "SB1", condition: "A decision is the user's", reason: "which cloud to sync to" });
plan("SB", ["RN"], 50);

// Paused, waiting for nothing: it stays first.
const fr = session(newId(), "FR worker", "FR");
queue("FR", "Hive sounds", [["FR1", "Ambient beds"], ["FR2", "Mixing"]]);
emit(fr, 80, { type: "step.started", queue: "FR", step: "FR1" });
st.writeRun("FR", { protocol: 1, session: fr.id, state: "paused", reason: "paused by the user", step: "FR1", started_at: ago(80), updated_at: ago(70), runtime: "claude", revision: 1 });

// Never ran: after SB.
queue("NX", "Map of the island", [["NX1", "Tiles"]]);
plan("NX", ["SB"], 40);
console.log(`seeded ${root}`);
