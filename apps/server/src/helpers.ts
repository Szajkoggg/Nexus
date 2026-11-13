// The file Claude Code's --agents reads: the subagents Nexus gives every orchestrator (ORCHESTRATOR_AGENTS, with the
// other texts agents receive, in src/prompts.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nexusHome } from "@nexus/protocol";
import { ORCHESTRATOR_AGENTS } from "./prompts.ts";

/** Writes the agents to a file for `--agents` (print mode reads a path) and returns it. */
export function orchestratorAgentsFile(): string {
  const dir = join(nexusHome(), "agents");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "orchestrator.json");
  writeFileSync(file, JSON.stringify(ORCHESTRATOR_AGENTS, null, 2), "utf8");
  return file;
}
