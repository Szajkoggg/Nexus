// Every numeric option of the CLI goes through one parser (numberArg, queue CHC, docs/protocol/cli.md, "The `nexus` CLI"):
// a wrong value is refused alike, `nexus: <what> takes <…>, not "<value>"` with exit code 2, before anything is
// written; a value the event's schema takes is accepted. The server's part (applying the orchestrator's metric and
// recurring requests) is played by a stand-in; no command here talks HTTP, and NEXUS_PORT points at a closed port all
// the same.
import { errorText } from "@nexus/protocol/errors";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, defineMetric, newId, now, type Event } from "@nexus/protocol";
import { cliRun, type CliResult } from "./run-cli.ts";

/** The first bytes of a PNG of that size: all the CLI reads of it. */
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b);
  b.write("IHDR", 12, "ascii"); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  return b;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nexus-cli-numbers-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const at = now();
  store.writeSession({ protocol: 1, id: "w", project: "p", role: "worker", runtime: "claude", cwd: root, launched_by: "nexus", created_at: at, queue: "Q" });
  store.writeSession({ protocol: 1, id: "o", project: "p", role: "orchestrator", runtime: "claude", cwd: root, launched_by: "nexus", created_at: at });
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "approved", stop_conditions: [], checks: ["test"], steps: [{ id: "Q1", title: "Step", goal: "", acceptance: [] }] });
  store.appendEvent({ v: 1, id: newId(), at, session: "w", type: "step.started", queue: "Q", step: "Q1" } as Event);
  writeFileSync(join(root, "notes.txt"), "notes\n");
  writeFileSync(join(root, "report.md"), "# Report\n");
  writeFileSync(join(root, "view.png"), png(984, 1600));
  // Port 1: closed, so a command that did talk to a server would fail here, never reach the live one.
  const env = (session: string): NodeJS.ProcessEnv => ({ ...process.env, NEXUS_DIR: store.dir, NEXUS_SESSION: session, NEXUS_HOME: join(root, "home"), NEXUS_PORT: "1" });
  /** `nexus <args>` as the session, while a stand-in for the server applies the orchestrator's requests. */
  const run = async (session: string, args: string[]): Promise<CliResult> => {
    let done = false;
    const child = cliRun(args, { cwd: root, env: env(session) }).finally(() => { done = true; });
    while (!done) {
      const applied = new Set(store.readApplied("o").entries.map((x) => x.event));
      for (const e of store.readEvents("o").entries) {
        if (applied.has(e.id)) continue;
        let ok = true; let message = "applied";
        if (e.type === "metric.defined") { try { message = defineMetric(store, e, e.session); } catch (err) { ok = false; message = errorText(err); } }
        store.appendApplied("o", { at: now(), event: e.id, ok, message });
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    return await child;
  };
  const written = () => store.readEvents("w").entries.length + store.readEvents("o").entries.length;
  return { run, written };
}

interface Case {
  /** The option as the refusal names it. */
  what: string;
  session: "w" | "o";
  /** The command with the value in place of `$`. */
  args: string[];
  bad: string;
  /** The refusal's "takes …" part. */
  takes: string;
  good: string;
  /** Run first, as the orchestrator (the metric a value is recorded for). */
  before?: string[];
}

const METRIC = ["metric", "define", "bundle-kb", "--unit", "KB"];
const CASES: Case[] = [
  { what: "--target", session: "o", args: [...METRIC, "--target=$"], bad: "lots", takes: "a number (for example 12, 3.5 or -2)", good: "-2.5" },
  { what: "--warn-above", session: "o", args: [...METRIC, "--warn-above=$"], bad: "5kb", takes: "a number (for example 12, 3.5 or -2)", good: "500" },
  { what: "--warn-below", session: "o", args: [...METRIC, "--warn-below=$"], bad: "", takes: "a number (for example 12, 3.5 or -2)", good: "-1.5" },
  { what: "<value>", session: "w", args: ["metric", "record", "bundle-kb", "$"], bad: "Infinity", takes: "a number (for example 12, 3.5 or -2)", good: "12.5", before: METRIC },
  { what: "--pct", session: "w", args: ["step", "progress", "Q1", "half way", "--pct=$"], bad: "150", takes: "a number from 0 to 100", good: "0" },
  { what: "--round", session: "w", args: ["review", "add", "Q1", "notes.txt", "--round=$"], bad: "1.5", takes: "a whole number (for example 3 or -2)", good: "2" },
  { what: "--round", session: "w", args: ["review", "add", "Q1", "view.png", "--key", "view@492", "--role", "result", "--round=$"], bad: "two", takes: "a whole number (for example 3 or -2)", good: "1" },
  { what: "--duration", session: "w", args: ["check", "Q1", "test", "--ok", "--duration=$"], bad: "-1", takes: "the check's time in seconds (for example 12 or 3.5)", good: "0" },
  { what: "--findings", session: "w", args: ["report", "Q", "--file", "report.md", "--summary", "s", "--findings=$"], bad: "1.5", takes: "a whole number of findings (0 or more)", good: "0" },
  { what: "--after-queues", session: "o", args: ["recurring", "set", "R", "--template", "maintenance", "--maintenance", "fix_small", "--after-queues=$"], bad: "0", takes: "a whole number from 1 to 1000", good: "1000" },
];

const fill = (args: string[], v: string) => args.map((a) => a.replace("$", v));

for (const c of CASES) {
  test(`${c.args.slice(0, 2).join(" ")} ${c.what}: "${c.bad}" is refused alike with exit code 2, "${c.good}" is accepted`, async () => {
    const x = setup();
    if (c.before) assert.equal((await x.run("o", c.before)).status, 0);
    const before = x.written();
    const bad = await x.run(c.session, fill(c.args, c.bad));
    assert.equal(bad.status, 2, bad.stderr);
    assert.equal(bad.stderr, `nexus: ${c.what} takes ${c.takes}, not "${c.bad}"\n`);
    assert.equal(x.written(), before, "nothing written when refused");
    const good = await x.run(c.session, fill(c.args, c.good));
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /^ok/);
    assert.ok(x.written() > before, "the accepted value's event is written");
  });
}
