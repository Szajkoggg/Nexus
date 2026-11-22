// The runtimes' names as the dashboard shows them, in one place (queue UF): product names, the same in every language
// (apps/web/test/strings.test.ts lets them through here only).

/** The runtimes Nexus runs agents on, in the order the choices list them. */
const RUNTIMES = ["claude", "codex"] as const;
export type RuntimeId = (typeof RUNTIMES)[number];

const NAME: Record<RuntimeId, string> = { claude: "Claude Code", codex: "Codex" };

/** A runtime's shown name; an id the dashboard does not know stays as it is. */
export const runtimeName = (id: string): string => (id in NAME ? NAME[id as RuntimeId] : id);

/** A runtime choice's options, [value, label] (Settings' selects). */
export const RUNTIME_OPTIONS: [RuntimeId, string][] = RUNTIMES.map((r) => [r, NAME[r]]);
