// Nexus's own plan as seed-plan-nexus.ts seeds it, but with only three finished steps' turns: fewer than the five the
// estimates need, so the plan's time axis shows what it does without them (queue PVA, step PVA4: plan-time-unknown).
//   node scripts/capture/seed-plan-unknown.ts <data dir>
process.env.NEXUS_SEED_FEW_TURNS = "1";
await import("./seed-plan-nexus.ts");
