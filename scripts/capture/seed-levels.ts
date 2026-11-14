// A seed for the capture tool: review levels and the return batch, away mode off (levels-fixture.ts).
// Run by scripts/capture.ts as `node <this> <data dir>` with NEXUS_HOME set to the development instance's.
import { seedLevels } from "./levels-fixture.ts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node seed-levels.ts <data dir>");
console.log(`seeded ${seedLevels(dir)}`);
