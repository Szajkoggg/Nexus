// A seed for the capture tool: Markdown tables in the chat and in a step's goal (queue MD, GFM in the dashboard's
// Markdown). Run by scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the development instance's;
// it writes only there.
//
// - "demo": the orchestrator answers with a small table (refs and a file in its cells), and queue TB's step TB1 has a
//   table in its goal.
// - "wide": the orchestrator answers with a table wider than a phone, which scrolls sideways inside the message.
// No process runs: the chats show the files.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, approveQueue, newId, writeRegistry, type ChatEntry, type SessionFile } from "@nexus/protocol";
import { requireTempHome } from "../temp-home.ts";

requireTempHome();

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-tables.ts <data dir>");
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

function project(id: string, name: string): { st: ProjectStore; chat: (min: number, from: ChatEntry["from"], text: string) => void } {
  const root = join(dir!, id);
  mkdirSync(root, { recursive: true });
  const st = ProjectStore.init(root, { id, name, root });
  const session: SessionFile = { protocol: 1, id: newId(), project: id, role: "orchestrator", runtime: "claude", native_id: null, title: "Orchestrator", cwd: root, launched_by: "nexus", created_at: ago(120) };
  st.writeSession(session);
  st.updateProject((p) => ({ ...p, orchestrator: { runtime: "claude", ...p.orchestrator, notify: false, session: session.id } }));
  return { st, chat: (min, from, text) => st.appendChat(session.id, { at: ago(min), from, text }) };
}

const demo = project("demo", "Demo app");
const wide = project("wide", "Wide tables");
writeRegistry({ protocol: 1, projects: [{ id: "demo", root: join(dir, "demo") }, { id: "wide", root: join(dir, "wide") }] });

demo.st.writeQueue({
  protocol: 1, id: "TB", title: "Search in the docs", revision: 1, status: "proposed", stop_conditions: [], checks: [],
  steps: [
    {
      id: "TB1", title: "Index the docs",
      goal: [
        "Build the search index for the docs, one entry per heading.",
        "",
        "| Field | Source | Weight |",
        "|---|---|---:|",
        "| title | the heading's text | 3 |",
        "| body | the section's paragraphs | 1 |",
        "| path | the file and its anchor | 0 |",
        "",
        "The index is rebuilt when a file under docs/ changes.",
      ].join("\n"),
      acceptance: ["Every heading of docs/ is found by its title"],
    },
    { id: "TB2", title: "Search box", goal: "A search box over the index.", acceptance: ["Done"] },
  ],
});
approveQueue(demo.st, "TB");

demo.chat(30, "user", "Where does the search queue stand?");
demo.chat(28, "orchestrator", [
  "Queue TB is approved and waits to start. Its two steps:",
  "",
  "| Step | What | Runtime | Status |",
  "|---|---|---|---|",
  "| TB1 | The index, one entry per heading | claude | waiting |",
  "| TB2 | The search box over it | codex | pending |",
  "",
  "TB1's weights are in its goal; the index format is in `docs/search.md:12`.",
].join("\n"));
demo.chat(20, "user", "Good, start it after lunch.");

wide.chat(30, "user", "Compare the three runtimes for the docs queue.");
wide.chat(28, "orchestrator", [
  "Here is the comparison:",
  "",
  "| Runtime | Model | Reasoning | Throughput | Cost per step | Recommendation |",
  "|---|---|---|---|---|---|",
  "| claude | opus | extended | comfortable | moderate | implementation and refactoring |",
  "| codex | luna | standard | quickest | cheapest | mechanical changes and translations |",
  "| claude | haiku | standard | quick | inexpensive | probes and documentation |",
  "",
  "I would keep the implementation steps on claude.",
].join("\n"));
console.log(`seeded ${dir}`);
