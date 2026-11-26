// A seed for the capture tool: one test project with Codex primary and Claude fallback (its own settings), for the
// orchestrator's part of the project's settings (queue OC). Nothing else: no queue, no session, so the orchestrator
// never starts. Run by scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the development
// instance's; it writes only there.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, writeRegistry } from "@nexus/protocol";
import { requireTempHome } from "../temp-home.ts";

requireTempHome();

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-orchestrator.ts <data dir>");
const root = join(dir, "demo");
mkdirSync(root, { recursive: true });
const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root });
st.updateProject((p) => ({ ...p, orchestrator: { notify: true, session: null, ...p.orchestrator, runtime: "codex", fallback: { runtime: "claude", model: "claude-sonnet-5-5", effort: "low" } } }), [], ["orchestrator.runtime"]);
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
console.log(`seeded ${root}`);
