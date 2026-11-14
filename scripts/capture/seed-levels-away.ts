// A seed for the capture tool: the same project as seed-levels.ts, with away mode on until 08:00 (levels-fixture.ts).
// Run by scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the development instance's.
import { seedLevels } from "./levels-fixture.ts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-levels-away.ts <data dir>");
console.log(`seeded ${seedLevels(dir, { away: true })}`);
