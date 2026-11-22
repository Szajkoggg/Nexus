// A preload for tests (clock-steps.test.ts): this process's wall clock is CLOCK_LAG_MS behind the system clock
// (negative: ahead), as a long-lived Node process's was on Windows for up to a minute after an NTP step of +240 s (V8
// re-reads the system time only once a minute; queue FL, FL2). Its child processes (the nexus CLI, the fake runtimes,
// git) keep the system clock, so the test process and its children disagree as the server and the agents did.
const lag = Number(process.env.CLOCK_LAG_MS ?? 0);
const RealDate = Date;
class LaggingDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(RealDate.now() - lag); else super(...args); }
  static now() { return RealDate.now() - lag; }
}
globalThis.Date = LaggingDate;
