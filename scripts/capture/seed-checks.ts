// A seed for the capture tool: a test project "demo" whose settings name checks for every step (defaults.checks) and
// stop conditions, and a queue waiting for approval with checks of its own. Run by
// scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the development instance's; it writes only
// there. Code from before defaults.checks reads the project without them, so it seeds a base commit from then too.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, writeRegistry, type ProjectFile } from "@nexus/protocol";
import { requireTempHome } from "../temp-home.ts";

requireTempHome();

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-checks.ts <data dir>");
const root = join(dir, "demo");
mkdirSync(root, { recursive: true });

const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
st.updateProject((p) => ({
  ...p,
  defaults: { ...p.defaults, stop_conditions: ["Anything would have to change in the live instance."], checks: ["npm run lint"] },
} as ProjectFile));

st.writeQueue({
  protocol: 1, id: "CK", title: "Search in the step list", revision: 1, status: "proposed",
  stop_conditions: ["The search would need a new API."], checks: ["npm run typecheck", "npm test"],
  steps: [
    { id: "CK1", title: "A search box over the steps", goal: "Typing filters the step list by title and goal.", acceptance: ["Filters as the user types", "Empty search shows all steps"] },
    { id: "CK2", title: "Keyboard", goal: "Ctrl+F focuses the search box; Escape clears it.", acceptance: ["Both keys work"] },
  ],
});
console.log(`seeded ${root}`);
