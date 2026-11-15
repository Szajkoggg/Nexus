// A seed for the capture tool: a test project "demo" whose history holds the word "pump" in every kind the search of
// a project's history finds (queue SR): a queue and its steps' goals, step outcomes, a question and its answer, a review
// comment, a step note, a report, the orchestrator's chat (an old message far up, and a tool line) and a thinking
// partner's chat. Run by scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the development
// instance's; it writes only there. No agent runs: the chats and events are the files.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, USER_SESSION, approveQueue, newId, normPath, writeRegistry, type ChatEntry, type Event, type SessionFile } from "@nexus/protocol";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-search.ts <data dir>");
const root = join(dir, "demo");
mkdirSync(root, { recursive: true });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
st.markReviewLevels(ago(7 * 24 * 60));
const session = (role: SessionFile["role"], title: string, created: number, o: Partial<SessionFile> = {}): SessionFile => {
  const s: SessionFile = { protocol: 1, id: newId(), project: "demo", role, runtime: role === "user" ? "external" : "claude", title, cwd: root, launched_by: role === "user" ? "external" : "nexus", created_at: ago(created), ...o };
  st.writeSession(s);
  return s;
};
const emitter = (s: SessionFile) => (min: number, body: Record<string, unknown>) => st.appendEvent({ v: 1, id: newId(), at: ago(min), session: s.id, ...body } as Event);
const chat = (s: SessionFile, min: number, from: ChatEntry["from"], text: string, kind?: ChatEntry["kind"]) => st.appendChat(s.id, { at: ago(min), from, text, ...(kind ? { kind } : {}) });

const orchestrator = session("orchestrator", "Orchestrator", 3000);
st.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", notify: false, ...p.orchestrator, session: orchestrator.id } }));
const user = session("user", "You (dashboard)", 3000, { id: USER_SESSION });
const fromUser = emitter(user);
const fromOrchestrator = emitter(orchestrator);

// WP: water and pumps, finished, with outcomes, a question and its answer, a review comment, a note and a report.
st.writeQueue({ protocol: 1, id: "WP", title: "Water and pumps", revision: 1, status: "proposed", review_level: 3, stop_conditions: [], checks: ["npm test"],
  description: "Water rises in the lower shafts below the old river line; the player holds it back with pumps built from wood.",
  steps: [
    { id: "WP1", title: "Pump placement", goal: "A pump can be placed on any shaft floor; each pump holds two rows of water.", acceptance: ["Unit tests for placing and holding"] },
    { id: "WP2", title: "Flooding rules", goal: "Water rises one row per minute below the river line and stops above it.", acceptance: ["A test for the river line"] },
  ] });
approveQueue(st, "WP");
const wp = emitter(session("worker", "WP worker", 2900, { queue: "WP" }));
wp(2800, { type: "step.started", queue: "WP", step: "WP1" });
wp(2700, { type: "step.done", queue: "WP", step: "WP1", summary: "Pumps can be placed on any shaft floor and hold two rows each; a pump on a ladder is refused. 18 unit tests." });
fromUser(2650, { type: "review.commented", queue: "WP", step: "WP1", path: normPath(join(root, "tmp/pump.png")), text: "The pump icon is too small next to the ladder; make it as wide as a tile.", to: "note", note_step: "WP2" });
fromOrchestrator(2640, { type: "review.accepted", queue: "WP", step: "WP1" });
st.writeNote("WP", { id: newId(), step: "WP2", from: "user", at: ago(2600) }, "From the review of WP1: draw the pump icon as wide as a tile.");
wp(2500, { type: "step.started", queue: "WP", step: "WP2" });
const qid = newId();
wp(2450, { type: "question.asked", queue: "WP", step: "WP2", qid, text: "Should a pump stop working when the water reaches its own row?", options: ["Yes, it floods", "No, it keeps pumping"], can_continue: false, recommended: "Yes, it floods" });
fromUser(2400, { type: "answer.given", qid, text: "Yes: a flooded pump stops, so the player has to place pumps ahead of the water." });
wp(2300, { type: "step.done", queue: "WP", step: "WP2", summary: "Water rises one row per minute below the river line; a flooded pump stops. 9 tests." });
fromOrchestrator(2290, { type: "review.accepted", queue: "WP", step: "WP2" });
const report = normPath(join(st.queueDir("WP"), "report.md"));
writeFileSync(report, "# Water and pumps\n\nPumps hold two rows each and stop once flooded. The river line decides where water rises.\n\n## Left for later\n\n- A pump sound that changes with the load.\n");
wp(2280, { type: "queue.report", queue: "WP", path: report, summary: "Pumps and flooding are in; the pump sound is left for later." });

// The orchestrator's chat: the pump talk is old, far above the newest messages, with a tool line among them.
chat(orchestrator, 2960, "user", "Before the water queue: how many rows should one pump hold?");
chat(orchestrator, 2959, "orchestrator", "Two rows per pump keeps it readable: one pump buys a little time, three make a shaft safe for a while. I put that into the goal of WP1.");
chat(orchestrator, 2958, "orchestrator", "Bash: grep -rn \"pump\" src/water", "tool");
const topics = ["the ladder sprites", "the ore colours", "the save format", "the sound mixer", "the cave lighting", "the map editor", "the tutorial text", "the cliff edges"];
for (let i = 0; i < 48; i++) {
  const topic = topics[i % topics.length]!;
  chat(orchestrator, 2000 - i * 30, i % 2 ? "orchestrator" : "user", i % 2
    ? `Noted about ${topic}. I will keep it in mind for the next queue and say so in its description.`
    : `One more thing about ${topic}: can it wait until after the release?`);
}

// A thinking partner's conversation.
const partner = session("conversation", "Water table", 1500);
chat(partner, 1490, "user", "Is a pump that floods too harsh for new players?");
chat(partner, 1489, "partner", "Not if the water warns first: a pump that sputters a few seconds before it floods gives the player time to place another one above it.");

console.log(`seeded ${root}`);
