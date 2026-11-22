// A seed for the capture tool: a test project "demo" for the context thresholds in tokens (queue CT): a run that went
// on in a fresh session because its context was beyond the threshold (run.yaml `switches`), and an orchestrator that
// went on in a fresh session (its context care) and whose fresh session reports its context (runtime.json). Run by
// scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the development instance's; it writes only
// there. It fits the code before and after CT2: the token figures it adds are left out by older schemas.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, ensureUserSession, newId, writeRegistry, type ChatEntry, type Event, type SessionFile } from "@nexus/protocol";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-context-tokens.ts <data dir>");
const root = join(dir, "demo");
mkdirSync(root, { recursive: true });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
const session = (id: string, role: "worker" | "orchestrator", min: number, extra: Partial<SessionFile> = {}): SessionFile => {
  const s: SessionFile = {
    protocol: 1, id, project: "demo", role, runtime: "claude", native_id: null, title: role === "worker" ? "Q worker" : "Orchestrator", cwd: root,
    launched_by: "nexus", created_at: ago(min), ...(role === "worker" ? { queue: "Q", model: "claude-opus-5-5" } : {}), ...extra,
  };
  st.writeSession(s);
  return s;
};

// The run: Q1 and Q2 in one session, whose context was 342k tokens of 1M at Q2's end; Q3 in a fresh one.
const a = session(newId(), "worker", 200), b = session(newId(), "worker", 40);
const emit = (s: SessionFile, min: number, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session: s.id, ...body } as Event);
const accept = (step: string, min: number) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session: ensureUserSession(st).id, type: "review.accepted", queue: "Q", step } as Event);
st.writeQueue({
  protocol: 1, id: "Q", title: "Import of the old saves", revision: 1, status: "proposed", stop_conditions: [], checks: ["npm test"],
  steps: [
    { id: "Q1", title: "Read the old format", goal: "A reader for version 3 saves.", acceptance: ["Every fixture reads"] },
    { id: "Q2", title: "Convert the fixtures", goal: "Convert the 40 fixtures to version 4.", acceptance: ["40 converted files"] },
    { id: "Q3", title: "Remove the old reader", goal: "Delete the version 3 reader.", acceptance: ["No reference left"] },
  ],
});
approveQueue(st, "Q");
emit(a, 190, { type: "step.started", queue: "Q", step: "Q1" });
emit(a, 150, { type: "step.done", queue: "Q", step: "Q1", summary: "The version 3 reader reads every fixture." });
accept("Q1", 148);
emit(a, 146, { type: "step.started", queue: "Q", step: "Q2" });
emit(a, 60, { type: "step.done", queue: "Q", step: "Q2", summary: "All 40 fixtures converted to version 4." });
accept("Q2", 58);
emit(a, 57, { type: "context.summary", queue: "Q", step: "Q2", text: "The converter lives in src/convert.ts.", topics: ["saves"], files: ["src/convert.ts"] });
emit(b, 38, { type: "step.started", queue: "Q", step: "Q3" });
emit(b, 20, { type: "step.progress", queue: "Q", step: "Q3", text: "the reader removed; fixing two imports", pct: 60 });
st.writeRun("Q", {
  protocol: 1, session: b.id, state: "running", step: "Q3", started_at: ago(200), updated_at: ago(38), revision: 1, runtime: "claude",
  switches: [{ at: ago(40), from: a.id, to: b.id, step: "Q3", why: "context", fill: 0.342, tokens: 342_000, summary: "written" } as never],
});

// The orchestrator: its old session went on in a fresh one at 512k tokens of 1M; the fresh one holds 212k now.
const oldId = newId(), freshId = newId();
const old = session(oldId, "orchestrator", 600, { continued_by: freshId });
const chat = (s: SessionFile, min: number, from: ChatEntry["from"], text: string) => st.appendChat(s.id, { at: ago(min), from, text });
chat(old, 70, "user", "Can the import queue run tonight?");
chat(old, 68, "orchestrator", "Yes: Q is approved and starts when you say so. Q3 removes the old reader once the fixtures are converted.");
chat(old, 36, "nexus", "The orchestrator's context is 512k tokens (51 % full; its threshold is 500k tokens): Nexus asked it for a summary, and it goes on in a fresh session.");
st.appendApplied(old.id, { at: ago(36), event: "context:asked", ok: true, message: "0.512", tokens: 512_000 } as never);
st.appendEvent({ v: 1, id: newId(), at: ago(35), session: old.id, type: "context.summary", text: "Decided: Q runs tonight.\nOpen: nothing.", topics: ["import"], files: [] } as Event);
chat(old, 35, "orchestrator", "Summary written.");
chat(old, 34, "nexus", `The orchestrator goes on in a fresh session (${freshId}).`);
const fresh = session(freshId, "orchestrator", 34, { continues: oldId });
chat(fresh, 34, "nexus", "A fresh orchestrator session: the previous one's context was 51 % full. It starts from the summary the previous session wrote (.nexus/orchestrator/summary.md), its current briefing and nexus status.");
chat(fresh, 33, "orchestrator", "I am caught up: Q runs tonight, Q3 is under way.");
chat(fresh, 10, "user", "Good. Anything for me?");
chat(fresh, 9, "orchestrator", "Nothing now: Q3's review comes when it is done.");
st.writeRuntime(freshId, { state: "exited", model: "claude-opus-5-5", context_tokens: 212_000, context_window: 1_000_000, turns: 3, updated_at: ago(9) });
st.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", ...p.orchestrator, notify: false, session: freshId } }));
st.writeOrchestratorSummary(`# Orchestrator summary\n\nWritten by orchestrator session ${oldId} at ${ago(35)}, when its context was 51 % full. The fresh session ${freshId} started from it.\n\nDecided: Q runs tonight.\nOpen: nothing.\n\nTopics: import\n`);
console.log(`seeded ${root}`);
