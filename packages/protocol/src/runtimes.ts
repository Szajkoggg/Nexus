// The runtimes a process of Nexus runs on (a worker, the orchestrator, a thinking partner, a review helper). Free of
// imports, so the dashboard takes it without the schemas (docs/protocol/runtimes.md).

/** A runtime a process runs on: Claude Code or Codex. */
export type WorkerRuntime = "claude" | "codex";

/**
 * A runtime setting or a session's runtime as the runtime its process runs on: `codex` is Codex, anything else
 * Claude Code (the orchestrator's `external`, a missing value). The one place that maps it, so a third runtime is one
 * change here.
 */
export function workerRuntime(x: string | undefined | null): WorkerRuntime {
  return x === "codex" ? "codex" : "claude";
}
