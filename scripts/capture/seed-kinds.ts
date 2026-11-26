// A seed for the capture tool: a test project "demo" whose settings follow the global kinds' defaults except one of
// its own (docs on Codex, its fallback wait), for the settings panel's "Kinds of work". Run by scripts/capture.ts as
// `node <this> <data dir>` with NEXUS_HOME set to the development instance's; it writes only there. Kinds are new:
// there is no base commit to seed.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, updateSettings, writeRegistry } from "@nexus/protocol";
import { requireTempHome } from "../temp-home.ts";

requireTempHome();

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-kinds.ts <data dir>");
const root = join(dir, "demo");
mkdirSync(root, { recursive: true });
const st = ProjectStore.init(root, { id: "demo", name: "Demo app", root, runtimes: { codex: { model: "gpt-6-astra" } } });
writeRegistry({ protocol: 1, projects: [{ id: "demo", root }] });
updateSettings(st, { kinds: { docs: { runtime: "codex", model: "gpt-6-luna", effort: "medium", fallback: ["wait"] } } });
console.log(`seeded ${root}`);
