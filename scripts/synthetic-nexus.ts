// Builds a synthetic .nexus shaped like Nexus's own (packages/protocol/test/synthetic.ts): the same tree for the same
// seed, at a scale of today's size. Prints what it wrote beside Nexus's own counts (the calibration).
//
//   node scripts/synthetic-nexus.ts <empty folder> [--scale 1] [--seed 20261120]
import { mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { NEXUS_SIZE, generateNexus } from "../packages/protocol/test/synthetic.ts";

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: { scale: { type: "string", default: "1" }, seed: { type: "string", default: "20261120" } } });
const root = positionals[0];
if (!root) throw new Error("usage: node scripts/synthetic-nexus.ts <empty folder> [--scale 1] [--seed 20261120]");
mkdirSync(root, { recursive: true });
if (readdirSync(root).length) throw new Error(`${root} is not empty`);
const t0 = performance.now();
const size = generateNexus(resolve(root), { scale: Number(o.scale), seed: Number(o.seed) });
console.log(`generated ${resolve(root)}\\.nexus at ${o.scale}x in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
console.log(JSON.stringify({ generated: size, nexus: NEXUS_SIZE }, null, 2));
