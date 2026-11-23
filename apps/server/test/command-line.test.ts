// The length of a Claude Code process's command line. Windows limits a whole command line to 32,767 characters, and a
// briefing passed as an argument once came within 1,400 of it (docs/design/engine.md, "The orchestrator's briefing and the command
// line"); briefings now go in a file. This keeps every role's command line well below the limit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, approveQueue, loadProjectState, routeAnswers } from "@nexus/protocol";
import { Engine } from "../src/engine.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { Conversations } from "../src/conversations.ts";
import { QUICK_ENGINE, WAIT_MS, until as waitUntil, LONGER } from "./wait.ts";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fake-claude.ts");
process.env.NEXUS_CLAUDE = FAKE;

/** Half of Windows' 32,767: room for briefings, rules and paths to grow without coming near it. */
const LIMIT = 16_000;

/** The command line as Windows gets it, at most: every argument quoted, with a space between (escapes aside). */
const commandLine = (argv: string[]) => [process.execPath, FAKE, ...argv].reduce((n, a) => n + a.length + 3, 0);

test("the orchestrator's, a thinking partner's and a worker's command lines stay well below Windows' limit; their briefings go in a file", { timeout: WAIT_MS * 4 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "nexus-cmdline-"));
  process.env.NEXUS_HOME = join(root, "home");
  process.env.FAKE_ARGS = join(root, "args.log");
  delete process.env.FAKE_LOG;
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  store.writeQueue({ protocol: 1, id: "Q", title: "Queue", revision: 1, status: "proposed", stop_conditions: [], checks: [], approvals: [], history: [],
    steps: [{ id: "Q1", title: "Step 1", goal: "FAKE: done", acceptance: [] }] });
  approveQueue(store, "Q");
  let orchestrator: Orchestrator;
  const engine: Engine = new Engine(store, () => tick(), QUICK_ENGINE);
  orchestrator = new Orchestrator(store, engine, () => tick());
  const conversations = new Conversations(store, orchestrator, () => {});
  function tick() { routeAnswers(store); orchestrator.onChange(loadProjectState(store)); engine.onChange(loadProjectState(store)); }
  const timer = setInterval(tick, 150);
  const starts = () => (existsSync(process.env.FAKE_ARGS!) ? readFileSync(process.env.FAKE_ARGS!, "utf8").trim().split("\n") : [])
    .map((l) => JSON.parse(l) as { argv?: string[]; briefing?: string | null }).filter((s) => s.argv);
  try {
    orchestrator.say("Hello");
    const c = conversations.create({ title: "Thinking" });
    conversations.say(c.id, "Hello");
    engine.start("Q");
    await waitUntil("three processes", () => starts().length >= 3, LONGER.run);
    const roles = [
      { role: "orchestrator", opening: "You are the orchestrator" },
      { role: "thinking partner", opening: "You are a thinking partner" },
      { role: "worker", opening: "You are a worker session" },
    ];
    for (const { role, opening } of roles) {
      const start = starts().find((s) => s.briefing?.startsWith(opening));
      assert.ok(start, `the ${role}'s start, its briefing read from --append-system-prompt-file (briefings: ${starts().map((s) => JSON.stringify(s.briefing?.slice(0, 40))).join(", ")})`);
      assert.ok(!start.argv!.includes("--append-system-prompt"), `the ${role}'s briefing is not on the command line`);
      const file = start.argv![start.argv!.indexOf("--append-system-prompt-file") + 1]!;
      assert.match(file, /[\\/]\.nexus[\\/]sessions[\\/][^\\/]+[\\/]briefing\.md$/, `the ${role}'s briefing is in its session's folder`);
      const length = commandLine(start.argv!);
      t.diagnostic(`${role}: command line ${length} characters; briefing ${start.briefing!.length} (in the file)`);
      assert.ok(length <= LIMIT, `the ${role}'s command line is ${length} characters, over the limit of ${LIMIT} this test keeps (Windows allows 32,767 in all)`);
    }
  } finally { clearInterval(timer); conversations.shutdown(); orchestrator.shutdown(); engine.shutdown(); delete process.env.FAKE_ARGS; }
});
