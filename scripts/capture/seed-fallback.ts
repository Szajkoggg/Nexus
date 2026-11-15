// A seed for the capture tool: a test project "demo" whose queue Q ran a step on its fallback because Claude Code's
// usage ran out, and went back to Claude Code at the next step (run.yaml `fallbacks`), for the step's "On Codex: …"
// line and the queue card. Run by scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the development
// instance's; it writes only there. Fallbacks are new: there is no base commit to seed.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, ensureUserSession, newId, writeRegistry, type Event, type SessionFile } from "@nexus/protocol";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-fallback.ts <data dir>");
const root = join(dir, "demo");
mkdirSync(root, { recursive: true });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
const session = (id: string, runtime: "claude" | "codex", model: string, min: number): SessionFile => {
  const s: SessionFile = { protocol: 1, id, project: "demo", role: "worker", runtime, native_id: runtime === "claude" ? "00000000-0000-4000-8000-00000000000a" : "thread-1", title: `Q worker (${id.slice(-1)})`, cwd: root, launched_by: "nexus", created_at: ago(min), queue: "Q", model };
  st.writeSession(s);
  return s;
};
const a = session(newId(), "claude", "claude-sonnet-5-5", 200);
const b = session(newId(), "codex", "gpt-6-luna", 120);
const c = session(newId(), "claude", "claude-sonnet-5-5", 40);
const emit = (s: SessionFile, min: number, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session: s.id, ...body } as Event);
const accept = (step: string, min: number) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session: ensureUserSession(st).id, type: "review.accepted", queue: "Q", step } as Event);

st.writeQueue({
  protocol: 1, id: "Q", title: "Import of the old saves", revision: 1, status: "proposed", stop_conditions: [], checks: ["npm test"], kind: "mechanical",
  steps: [
    { id: "Q1", title: "Read the old format", goal: "A reader for version 3 saves.", acceptance: ["Every fixture reads"] },
    { id: "Q2", title: "Convert the fixtures", goal: "Convert the 40 fixtures to version 4.", acceptance: ["40 converted files"] },
    { id: "Q3", title: "Remove the old reader", goal: "Delete the version 3 reader.", acceptance: ["No reference left"] },
    { id: "Q4", title: "Release notes", goal: "Say what changed.", acceptance: ["Written"], kind: "docs" },
  ],
});
approveQueue(st, "Q");
emit(a, 190, { type: "step.started", queue: "Q", step: "Q1" });
emit(a, 150, { type: "step.done", queue: "Q", step: "Q1", summary: "The version 3 reader reads every fixture." });
accept("Q1", 148);
emit(b, 118, { type: "step.started", queue: "Q", step: "Q2" });
emit(b, 60, { type: "step.done", queue: "Q", step: "Q2", summary: "All 40 fixtures converted to version 4." });
accept("Q2", 58);
emit(c, 38, { type: "step.started", queue: "Q", step: "Q3" });
emit(c, 20, { type: "step.progress", queue: "Q", step: "Q3", text: "the reader removed; fixing two imports", pct: 60 });
const own = { runtime: "claude" as const, model: "claude-sonnet-5-5", effort: "low" as const };
const codex = { runtime: "codex" as const, model: "gpt-6-luna", effort: "low" as const };
st.writeRun("Q", {
  protocol: 1, session: c.id, state: "running", step: "Q3", started_at: ago(200), updated_at: ago(38), revision: 1, runtime: "claude", from_defaults: ["runtime", "model", "effort"],
  switches: [
    { at: ago(120), from: a.id, to: b.id, step: "Q2", why: "runtime", summary: "written" },
    { at: ago(40), from: b.id, to: c.id, step: "Q3", why: "runtime", summary: "written" },
  ],
  fallbacks: [
    { at: ago(121), step: "Q2", ...codex, from: own, reason: "Claude Code's 5-hour window at 96 % (limit 90 %)" },
    { at: ago(41), step: "Q3", ...own, from: codex, reason: "its usage is below the limit again", back: true },
  ],
});
console.log(`seeded ${root}`);
