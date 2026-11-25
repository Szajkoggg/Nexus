// Claude Code's settling when the server's event loop stalls longer than the moment (queue LH; a side finding of queue
// CI3A): after the stall the expired timer runs before the I/O that came meanwhile, so a late turn the CLI started in
// time was taken for none. Both settlings decide after the loop's I/O: the one after a turn that had a `next` message
// sent into it (claude.ts, startSettling), and a stop's (settleStop, queue LCF; LC2's finding 2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeSession } from "../src/claude.ts";
import { fakeHistory } from "./fake-behaviour.ts";
import { stallAt } from "./stall.ts";

const here = dirname(fileURLToPath(import.meta.url));
process.env.NEXUS_CLAUDE = join(here, "fake-claude.ts");

/** The settling moment in these tests, and the loop's stall: at least this much past it. */
const LATE_TURN_MS = 20;
const STALL_MS = LATE_TURN_MS + 25;

/** A session on the fake whose first turn ends only once a `next` message came, which runs as a late turn behind `gate`. */
function lateSession() {
  const cwd = mkdtempSync(join(tmpdir(), "nexus-settling-"));
  process.env.NEXUS_HOME = join(cwd, "home");
  process.env.FAKE_LOG = join(cwd, "fake.log");
  const gate = join(cwd, "late-gate");
  process.env.FAKE_LATE_NEXT = "1";
  process.env.FAKE_LATE_GATE = gate;
  const uuid = randomUUID();
  const proc = new ClaudeSession({ cwd, uuid, resume: false, permissionMode: "dontAsk", allowedTools: [], env: {}, lateTurnMs: LATE_TURN_MS });
  return {
    proc, gate,
    /** The fake took `text` in as a turn: that turn's start is written to its output already. */
    takenIn: (text: string) => () => fakeHistory(uuid).includes(text),
    /** The messages the fake read, in order: whether a turn ran as each came. */
    received: () => readFileSync(process.env.FAKE_LOG!, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { text: string; busy: boolean }),
    end: () => { delete process.env.FAKE_LATE_NEXT; delete process.env.FAKE_LATE_GATE; delete process.env.FAKE_LOG; proc.kill(); },
  };
}

test("a late turn that starts in time while the event loop stalls past the settling moment is no `settled` (queue LH, (a))", async () => {
  const s = lateSession();
  const { proc } = s;
  const seen: string[] = [];
  try {
    proc.on("settled", () => seen.push("settled"));
    proc.on("activity", (a) => { if (a.kind === "turn_start") seen.push("turn_start"); });
    // The CLI starts the late turn at once (the gate opens at the turn's end), while this server's loop stalls for
    // longer than the settling moment, until that turn's start is written.
    const stalled = stallAt(proc, "turnEnd", STALL_MS, { until: s.takenIn("sent into the turn") });
    let ends = 0;
    const second = new Promise<void>((r) => proc.on("turnEnd", () => {
      seen.push("turnEnd");
      if (++ends === 1) writeFileSync(s.gate, ""); else r();
    }));
    proc.send("first");
    await new Promise<void>((r) => proc.once("message", () => r()));
    proc.send("sent into the turn", "next");
    await stalled;
    await second;
    assert.deepEqual(seen, ["turn_start", "turnEnd", "turn_start", "turnEnd"], "the late turn began: the moment did not end with `settled`");
  } finally {
    s.end();
  }
});

test("a stop's settling, the event loop stalled past its moment as a late turn starts: the late turn is interrupted at its start, and the held message runs as the next turn after its result (queue LCF, LC2 finding 2)", async () => {
  const s = lateSession();
  const { proc } = s;
  const seen: string[] = [];
  const messages: string[] = [];
  try {
    proc.on("activity", (a) => { if (a.kind === "turn_start") seen.push("turn_start"); });
    proc.on("message", (t) => messages.push(t));
    // The stopped turn's result sets the stop's settling timer after its `turnEnd`: the stall comes after it, so the
    // timer expires during the stall, and lasts until the CLI has written the late turn's start (the gate opened).
    const stalled = stallAt(proc, "turnEnd", STALL_MS, { until: s.takenIn("FAKE-SLOW late") });
    let ends = 0;
    const third = new Promise<void>((r) => proc.on("turnEnd", (e) => {
      seen.push(`turnEnd:${e.ok ? "ok" : e.text}`);
      if (++ends === 1) {
        writeFileSync(s.gate, "");
        proc.send("held"); // while the stop settles: held back
      }
      if (ends === 3) r();
    }));
    proc.send("first");
    await new Promise<void>((r) => proc.once("message", () => r()));
    // FAKE-SLOW: the late turn would take seconds unless it is interrupted.
    proc.send("FAKE-SLOW late", "next");
    assert.equal(proc.stop(), true);
    await stalled;
    await third;
    assert.deepEqual(seen, ["turn_start", "turnEnd:stopped", "turn_start", "turnEnd:stopped", "turn_start", "turnEnd:ok"],
      "the late turn ran as a stopped turn, and the held message's turn came right after its result");
    assert.equal(messages.length, 2, `nothing of the late turn is shown, the held message's turn replied once: ${JSON.stringify(messages)}`);
    const received = s.received();
    assert.deepEqual(received.map((r) => r.text), ["first", "FAKE-SLOW late", "[control] interrupt", "[control] interrupt", "held"],
      "the stopped turn and the late turn were each interrupted, then the held message was sent");
    assert.equal(received.at(-1)!.busy, false, "the held message reached the CLI after the late turn's result, never while it ran");
  } finally {
    s.end();
  }
});
