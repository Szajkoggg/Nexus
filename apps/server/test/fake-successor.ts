// A stand-in for the server a predecessor starts after an update (src/handover.ts), for testing the predecessor's
// side without a real server. FAKE_SUCCESSOR says what it does:
//   ready   after FAKE_READY_MS (default 500) it writes ready.json, then waits to be released
//   never   it sends no signal and lives on (until FAKE_LIFE_MS, default 30 s)
//   fail    it reports a failed smoke check and exits 1
// FAKE_SUCCESSOR_LOG (a file) gets one JSON line with what it saw.
import { appendFileSync } from "node:fs";
import { Standby, isAlive } from "../src/handover.ts";

const standby = new Standby(process.env.NEXUS_HANDOVER!);
const log = (what: unknown) => { if (process.env.FAKE_SUCCESSOR_LOG) appendFileSync(process.env.FAKE_SUCCESSOR_LOG, JSON.stringify(what) + "\n"); };
const behaviour = process.env.FAKE_SUCCESSOR ?? "ready";

if (behaviour === "fail") {
  standby.failed("fake smoke check failure");
  process.exit(1);
} else if (behaviour === "never") {
  setTimeout(() => process.exit(0), Number(process.env.FAKE_LIFE_MS ?? 30_000));
} else {
  setTimeout(async () => {
    const predecessor = standby.predecessor();
    standby.ready({ commit: "fake-new", subject: "the stand-in successor" });
    const readyAt = Date.now();
    const { released } = await standby.released();
    log({ readyAt, releasedAt: Date.now(), released: released ?? null, predecessorAliveAtReady: predecessor ? isAlive(predecessor.pid) : null });
    process.exit(0);
  }, Number(process.env.FAKE_READY_MS ?? 500));
}
