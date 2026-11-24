// The shell commands Nexus lets an agent run, as Claude Code allow rules on every shell tool it has. A role names its
// command prefixes once; each becomes a rule on Bash and on PowerShell, so a command allowed in one shell is allowed in
// the other and nothing more (queue SH). Another shell tool goes in SHELL_TOOLS.
//
// Probed on 2026-11-15 with Claude Code 2.1.323 (docs/design/engine-failures.md, "The same commands on every shell tool"):
// `PowerShell(<prefix>:*)` has Bash's shape and, like it, checks every subcommand: a chained, piped, redirected or
// nested command, or one with a flag before the subcommand (`git -C <path> show`), is refused under dontAsk. A rule
// for a shell tool the machine lacks (PowerShell switched off, as on Linux or macOS without pwsh) does no harm.

/** Claude Code's shell tools. */
export const SHELL_TOOLS = ["Bash", "PowerShell"] as const;

/** Allow rules for command prefixes (`nexus`, `git show`), each on every shell tool: `Bash(git show:*)`, `PowerShell(git show:*)`. */
export function shellRules(prefixes: readonly string[]): string[] {
  return prefixes.flatMap((p) => SHELL_TOOLS.map((tool) => `${tool}(${p}:*)`));
}
