// The effort levels a runtime's models take, from the runtime's own model list (GET /api/models/:runtime).
import type { ModelInfo } from "@nexus/protocol";

const ORDER = ["low", "medium", "high", "xhigh", "max", "ultra"];
const FALLBACK: Record<"claude" | "codex", string[]> = { claude: ["low", "medium", "high", "xhigh", "max"], codex: ["low", "medium", "high", "xhigh"] };

/** Every level some model of the runtime takes, in order; the runtime's fixed levels when its list names none. */
export function effortLevels(runtime: "claude" | "codex", models: readonly ModelInfo[] | undefined): string[] {
  const all = new Set((models ?? []).flatMap((m) => m.efforts ?? []));
  return all.size ? ORDER.filter((e) => all.has(e)) : FALLBACK[runtime];
}
