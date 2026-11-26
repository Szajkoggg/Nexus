// A seed for the capture tool: a test project "demo" whose orchestrator went on in a fresh session (its context care,
// queue CC), for the orchestrator's chat with the line at the switch. Run by scripts/capture.ts as
// `node <this> <data dir>` with NEXUS_HOME set to the development instance's; it writes only there.
//
// - The old session: a short conversation, Nexus's request for the summary at 91 %, its summary (a context.summary
//   event) and the line that it went on in a fresh session.
// - The fresh session: Nexus's line that it starts from the summary, its first reply, and the user's next message.
// - .nexus/orchestrator/summary.md as the server writes it. No process runs: the chat shows the files.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, newId, writeRegistry, type ChatEntry, type Event, type SessionFile } from "@nexus/protocol";
import { requireTempHome } from "../temp-home.ts";

requireTempHome();

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-fresh-session.ts <data dir>");
const root = join(dir, "demo");
mkdirSync(root, { recursive: true });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
st.writeQueue({ protocol: 1, id: "SD", title: "Search in the docs", revision: 1, status: "proposed", stop_conditions: [], checks: [],
  steps: [{ id: "SD1", title: "Index the docs", goal: "An index.", acceptance: ["Done"] }, { id: "SD2", title: "Search box", goal: "A search box.", acceptance: ["Done"] }] });
approveQueue(st, "SD");

const orchestrator = (id: string, created: number, extra: Partial<SessionFile> = {}): SessionFile => {
  const s: SessionFile = { protocol: 1, id, project: "demo", role: "orchestrator", runtime: "claude", native_id: null, title: "Orchestrator", cwd: root, launched_by: "nexus", created_at: ago(created), ...extra };
  st.writeSession(s);
  return s;
};
const chat = (s: SessionFile, min: number, from: ChatEntry["from"], text: string) => st.appendChat(s.id, { at: ago(min), from, text });

const oldId = newId(), freshId = newId();
const old = orchestrator(oldId, 600, { continued_by: freshId });
chat(old, 70, "user", "Can the search box ship before the index is finished?");
chat(old, 68, "orchestrator", "Not on its own: the search box reads the index that SD1 builds. I put SD2 right after SD1 in queue SD, so it starts as soon as SD1 is accepted. Meanwhile I can draft the highlighting as a separate queue if you want it this week.");
chat(old, 40, "user", "Yes, draft it, and keep the docs digest for Friday.");
chat(old, 38, "orchestrator", "Done: queue HL is drafted and waits for your approval. The Friday digest is noted.");
chat(old, 36, "nexus", "The orchestrator's context is 91 % full (its threshold is 85 %): Nexus asked it for a summary, and it goes on in a fresh session.");
const asked = ago(36);
st.appendApplied(old.id, { at: asked, event: "context:asked", ok: true, message: "0.91" });
st.appendEvent({
  v: 1, id: newId(), at: ago(35), session: old.id, type: "context.summary",
  text: "Decided: SD2 runs right after SD1; highlighting is its own queue (HL, drafted, waits for approval).\nOpen: the user's approval of HL.\nPlan: SD1, then SD2; HL after the user approves it.\nPromised: the docs digest on Friday.",
  topics: ["search", "plan", "digest"], files: ["docs/search.md"],
} as Event);
chat(old, 35, "orchestrator", "Summary written.");
chat(old, 34, "nexus", `The orchestrator goes on in a fresh session (${freshId}).`);

const fresh = orchestrator(freshId, 34, { continues: oldId });
chat(fresh, 34, "nexus", "A fresh orchestrator session: the previous one's context was 91 % full. It starts from the summary the previous session wrote (.nexus/orchestrator/summary.md), its current briefing and nexus status.");
chat(fresh, 33, "orchestrator", "I am caught up: SD1 is next, SD2 follows it, and HL waits for your approval. The docs digest is still due on Friday.");
chat(fresh, 10, "user", "Good. What is left before Friday?");
chat(fresh, 9, "orchestrator", "Two things: your approval of HL, and the SD queue's run, which starts when you say so. The digest itself I prepare on Thursday evening.");
st.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", ...p.orchestrator, notify: false, session: freshId } }));
st.writeOrchestratorSummary(`# Orchestrator summary\n\nWritten by orchestrator session ${oldId} at ${ago(35)}, when its context was 91 % full. The fresh session ${freshId} started from it.\n\nDecided: SD2 runs right after SD1; highlighting is its own queue (HL, drafted, waits for approval).\nOpen: the user's approval of HL.\nPlan: SD1, then SD2; HL after the user approves it.\nPromised: the docs digest on Friday.\n\nTopics: search, plan, digest\nFiles: docs/search.md\n`);
console.log(`seeded ${root}`);
