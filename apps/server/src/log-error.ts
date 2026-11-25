// A failure written to the server's log with where it happened and its stack, so a halted run's one-line reason
// can be traced to the line that threw (the engine's catches log here before they halt).
import { errorText } from "@nexus/protocol/errors";

/** Logs `e` with the place it was caught (`where`): an Error's stack, anything else as its text. */
export function logError(where: string, e: unknown): void {
  console.error(`${new Date().toISOString()} ${where}: ${e instanceof Error && e.stack ? e.stack : errorText(e)}`);
}
