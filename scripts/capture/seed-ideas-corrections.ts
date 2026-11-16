// IC1's before fixture: IO's synthetic notes with every suggestion already decided.
// The imported seed writes only the capture tool's isolated demo project.
import "./seed-ideas.ts";
import { join } from "node:path";
import { ProjectStore, loadProjectState } from "@nexus/protocol";
import { ideaMatches } from "../../packages/protocol/src/ideas-read.ts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-ideas-corrections.ts <data dir>");
const store = new ProjectStore(join(dir, "demo", ".nexus"));
const old = store.readIdeaMatches();
const pending = ideaMatches(store, loadProjectState(store)).items.filter((m) => !m.decision);
store.writeIdeaMatches({ ...old, matches: [...old.matches, ...pending.map((m) => ({
  queue: m.queue, ref: m.ref, kind: m.kind, quote: m.quote, accepted: false, at: "2026-11-16T08:02:00.000Z",
}))] });
