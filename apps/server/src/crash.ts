// A server that ends on an uncaught exception (queue KM). The rule stays as it was: the server logs the stack and exits
// with 1. Before it exits it also records the failure in <NEXUS_HOME>/crash.json, so that the next server can tell:
// the dashboard shows it until the user closes it, and every project's orchestrator is told once (its applied.jsonl
// records `notify:crash:<at>`). One record, the latest: a later crash replaces it. Writers: the server that crashes
// (the record) and the server that runs after it (the user's dismissal), never at once.
import { errorText } from "@nexus/protocol/errors";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nexusHome, writeJson } from "@nexus/protocol";

export interface CrashRecord {
  /** When the exception ended the server (ISO). */
  at: string;
  /** Its first line: the error's name and message, clipped. */
  error: string;
  stack?: string;
  pid: number;
  /** The user closed the dashboard's notice of it. */
  dismissed_at?: string;
}

export const crashFile = () => join(nexusHome(), "crash.json");

/** The error's first line, as the notice shows it. */
function crashText(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const line = text.split(/\r?\n/)[0]!.trim() || "unknown error";
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

function write(r: CrashRecord): void {
  writeJson(crashFile(), r);
}

/** Records the exception that ends this server. Synchronous (the process exits next) and never throws. */
export function recordCrash(err: unknown, at = new Date()): void {
  try {
    write({ at: at.toISOString(), error: crashText(err), stack: err instanceof Error ? err.stack : undefined, pid: process.pid });
  } catch (e) {
    try { process.stderr.write(`crash.json not written: ${errorText(e)}\n`); } catch { /* nothing left to tell */ }
  }
}

/** The latest crash recorded, dismissed or not; none if there was none (or its file is unreadable). */
export function readCrash(): CrashRecord | undefined {
  const f = crashFile();
  if (!existsSync(f)) return undefined;
  try {
    const r = JSON.parse(readFileSync(f, "utf8")) as Partial<CrashRecord>;
    return typeof r.at === "string" && typeof r.error === "string" ? r as CrashRecord : undefined;
  } catch { return undefined; }
}

/** What the dashboard shows: the latest crash, until the user closes it. */
export function crashNotice(): { at: string; error: string } | null {
  const r = readCrash();
  return r && !r.dismissed_at ? { at: r.at, error: r.error } : null;
}

/** The user closed the notice of the crash at `at`: false if that is no longer the latest one. */
export function dismissCrash(at: string, now = new Date()): boolean {
  const r = readCrash();
  if (!r || r.at !== at) return false;
  if (!r.dismissed_at) write({ ...r, dismissed_at: now.toISOString() });
  return true;
}
