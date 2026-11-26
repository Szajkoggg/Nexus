// A seed for the capture tool: the demo project (seed-demo.ts) on a server whose predecessor ended on an uncaught
// exception (queue KM): <NEXUS_HOME>/crash.json as src/crash.ts writes it, for the dashboard's notice at the top. Run
// by scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the development instance's; it writes only
// there. The notice is new: there is no base commit to seed.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nexusHome } from "@nexus/protocol";
import { requireTempHome } from "../temp-home.ts";

requireTempHome();

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-crash.ts <data dir>");
execFileSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "seed-demo.ts"), dir], { stdio: "inherit" });
const at = new Date(Date.now() - 12 * 60_000).toISOString();
const error = "TypeError: Cannot read properties of undefined (reading 'steps')";
writeFileSync(join(nexusHome(), "crash.json"), JSON.stringify({
  at, error, pid: 4242,
  stack: `${error}\n    at Engine.advance (apps/server/src/engine.ts:812:31)\n    at Engine.onChange (apps/server/src/engine.ts:402:12)`,
}, null, 2) + "\n");
