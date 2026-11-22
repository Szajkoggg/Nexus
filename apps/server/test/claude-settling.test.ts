// Claude Code's settling after a turn that had a `next` message sent into it (claude.ts, startSettling), when the
// server's event loop stalls longer than the moment (queue LH; a side finding of queue CI3A): after the stall the
// expired timer runs before the I/O that came meanwhile, so a late turn the CLI started in time was taken for none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeSession } from "../src/claude.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");

/** Blocks the event loop for `ms` (a busy machine, a long synchronous derivation). */
const stall = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* busy */ } };

test("a late turn that starts in time while the event loop stalls past the settling moment is no `settled` (queue LH, (a))", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "nexus-settling-"));
  process.env.NEXUS_HOME = join(cwd, "home");
  delete process.env.FAKE_LOG;
  const gate = join(cwd, "late-gate");
  process.env.FAKE_LATE_NEXT = "1";
  process.env.FAKE_LATE_GATE = gate;
  const proc = new ClaudeSession({ cwd, uuid: randomUUID(), resume: false, permissionMode: "dontAsk", allowedTools: [], env: {}, lateTurnMs: 100 });
  const seen: string[] = [];
  try {
    proc.on("settled", () => seen.push("settled"));
    proc.on("activity", (a) => { if (a.kind === "turn_start") seen.push("turn_start"); });
    let ends = 0;
    const second = new Promise<void>((r) => proc.on("turnEnd", () => {
      seen.push("turnEnd");
      if (++ends === 1) {
        // The CLI starts the late turn at once (the gate opens now), while this server's loop stalls for longer than
        // the settling moment.
        writeFileSync(gate, "");
        stall(600);
      } else r();
    }));
    proc.send("first");
    await new Promise<void>((r) => proc.once("message", () => r()));
    proc.send("sent into the turn", "next");
    await second;
    assert.deepEqual(seen, ["turn_start", "turnEnd", "turn_start", "turnEnd"], "the late turn began: the moment did not end with `settled`");
  } finally {
    delete process.env.FAKE_LATE_NEXT; delete process.env.FAKE_LATE_GATE;
    proc.kill();
  }
});
