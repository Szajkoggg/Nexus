// The CLI's role matrix (queue ACX, ACX4; the survey's recommended addition 2): every usage line of `nexus help` runs
// in this process as a worker, an orchestrator, a thinking partner, a review helper and without a session, each in a
// fresh project. A refusal for the role comes exactly where the help's text marks the line "(X only)" (and, for a
// review helper, where the help's helper rule leaves it out), and never for a command the role's own briefing names.
// Only what the role checks say is asserted: a call that fails for another reason (an unknown question, a step not in
// review) still shows whether the role was let through. The server commands talk HTTP and are left out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, approveQueue, newId, now, type Event, type Role, type SessionFile } from "@nexus/protocol";
import { cliRun, type CliResult } from "../../../packages/cli/test/run-cli.ts";
import { head, helpText } from "../../../packages/cli/test/cli-usage.ts";
import { helperBriefing, orchestratorBriefing, partnerBriefing, workerBriefing } from "../src/prompts.ts";

type Who = "worker" | "orchestrator" | "conversation" | "helper" | "none";
const ROLES: Who[] = ["worker", "orchestrator", "conversation", "helper", "none"];
const SESSION: Record<Exclude<Who, "none">, string> = { worker: "w", orchestrator: "o", conversation: "c", helper: "h" };

/** A fresh project: queue Q (step Q1 started by worker w, check "npm test"), queue R, a note file, a queue file. */
function project() {
  const root = mkdtempSync(join(tmpdir(), "nexus-role-matrix-"));
  const store = ProjectStore.init(root, { id: "p", name: "P", root });
  const at = now();
  const sessions: [string, Role, Partial<SessionFile>][] = [
    ["w", "worker", { queue: "Q" }], ["o", "orchestrator", {}], ["c", "conversation", {}],
    ["h", "helper", { about: { queue: "Q", step: "Q1", round: 1, level: 2 } }],
  ];
  for (const [id, role, extra] of sessions) store.writeSession({ protocol: 1, id, project: "p", role, runtime: "claude", cwd: root, launched_by: "nexus", created_at: at, ...extra });
  for (const id of ["Q", "R"]) {
    store.writeQueue({ protocol: 1, id, title: id, revision: 1, status: "proposed", stop_conditions: [], checks: ["npm test"], steps: [{ id: `${id}1`, title: "One", goal: "", acceptance: [] }] });
    approveQueue(store, id);
  }
  store.appendEvent({ v: 1, id: newId(), at, session: "w", type: "step.started", queue: "Q", step: "Q1" } as Event);
  writeFileSync(join(root, "doc.md"), "# Title\n\n## Part\n\nText.\n");
  writeFileSync(join(root, "report.md"), "# Report\n");
  writeFileSync(join(root, "queues.md"), "# Nothing\n");
  return { root, store };
}

/**
 * The server's stand-in: answers every event of an agent session in its applied.jsonl, as the server would, so the
 * requests that wait for it (queue draft, queue set, tags propose, …) end at once.
 */
function answering(store: ProjectStore): () => void {
  const seen = new Set<string>();
  const timer = setInterval(() => {
    for (const s of Object.values(SESSION)) {
      for (const e of store.readEvents(s).entries) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        store.appendApplied(s, { at: now(), event: e.id, ok: true, message: "the stand-in's answer" });
      }
    }
  }, 20);
  return () => clearInterval(timer);
}

/** A concrete call for each usage of the help, by the start of its text. */
const CALLS: [string, (root: string) => string[], string?][] = [
  ["nexus status", () => ["status"]],
  ["nexus step start", () => ["step", "start", "Q1"]],
  ["nexus step progress", () => ["step", "progress", "Q1", "half"]],
  ["nexus step done", () => ["step", "done", "Q1", "--summary", "done"]],
  ["nexus step failed", () => ["step", "failed", "Q1", "--reason", "no"]],
  ["nexus review add", () => ["review", "add", "Q1", "https://example.com/x", "--label", "x"]],
  ["nexus check <step> <name> --ok", () => ["check", "Q1", "npm test", "--ok"]],
  ["nexus check <step> <name> --unrelated", () => ["check", "Q1", "npm test", "--unrelated", "--evidence", "fails on main"]],
  ["nexus check decide", () => ["check", "decide", "Q", "Q1", "accept", "--reason", "r"]],
  ["nexus metric record", () => ["metric", "record", "size", "1"]],
  ["nexus metric list", () => ["metric", "list"]],
  ["nexus metric define", () => ["metric", "define", "size", "--unit", "KB"]],
  ["nexus stats", () => ["stats"]],
  ["nexus stop", () => ["stop", "Q1", "--condition", "c", "--reason", "r"]],
  ["nexus ask", () => ["ask", "Which page?"]],
  ["nexus withdraw", () => ["withdraw", "01NOSUCHQUESTION", "--reason", "r"]],
  ["nexus context", () => ["context", "Where it stands."]],
  ["nexus report", (root) => ["report", "Q", "--file", join(root, "report.md"), "--summary", "s"]],
  ["nexus covers", () => ["covers", "note.md#2026-11-14"]],
  ["nexus ideas matches", () => ["ideas", "matches"]],
  ["nexus ideas status", () => ["ideas", "status"]],
  ["nexus doc", () => ["doc", "doc.md"]],
  ["nexus log", () => ["log", "a line"]],
  ["nexus answer", () => ["answer", "01NOSUCHQUESTION", "An answer."]],
  ["nexus queue draft <file.yaml|->", () => ["queue", "draft", "-"], "id: N\ntitle: New\nsteps:\n  - { id: N1, title: One, goal: x, acceptance: [] }\n"],
  ["nexus queue draft --template", () => ["queue", "draft", "--template", "spike", "--set", "question=Why?", "--id", "SP"]],
  ["nexus queue set", () => ["queue", "set", "R", "cancelled", "--reason", "r"]],
  ["nexus recurring set", () => ["recurring", "set", "weekly", "--template", "maintenance", "--every", "mon 03:00"]],
  ["nexus recurring list", () => ["recurring", "list"]],
  ["nexus static-analysis [status]", () => ["static-analysis", "status"]],
  ["nexus static-analysis decline", () => ["static-analysis", "decline", "--reason", "r"]],
  ["nexus template list", () => ["template", "list"]],
  ["nexus template show", () => ["template", "show", "spike"]],
  ["nexus review accept", () => ["review", "accept", "Q", "Q1"]],
  ["nexus review send-back", () => ["review", "send-back", "Q", "Q1", "Fix it."]],
  ["nexus review audit", () => ["review", "audit", "Q", "Q1", "agree", "--reason", "r"]],
  ["nexus review pass-on", () => ["review", "pass-on", "Q", "Q1", "--why", "doubt", "--findings", "f"]],
  ["nexus review ask-user", () => ["review", "ask-user", "Q", "Q1", "Yours."]],
  ["nexus review provisional", () => ["review", "provisional", "Q", "Q1"]],
  ["nexus review decide", () => ["review", "decide", "Q", "Q1", "D1", "--choice", "A", "--reason", "r"]],
  ["nexus decide", () => ["decide", "Q1", "Which layout?", "--option", "A", "--option", "B"]],
  ["nexus run <queue> start|pause", () => ["run", "R", "pause", "--reason", "r"]],
  ["nexus run <queue> cancel-start", () => ["run", "R", "cancel-start", "--reason", "r"]],
  ["nexus plan propose", () => ["plan", "propose", "R", "--after", "Q", "--reason", "r"]],
  ["nexus tags propose", () => ["tags", "propose", "--area", "engine"]],
  ["nexus tags rename", () => ["tags", "rename", "engine", "motor"]],
  ["nexus tags", () => ["tags"]],
  ["nexus help", () => ["help"]],
  ["nexus project add", (root) => ["project", "add", root]],
  ["nexus project list", () => ["project", "list"]],
  ["nexus import", () => ["import", "queues.md", "--dry-run"]],
  ["nexus attach", () => ["attach"]],
  ["nexus note", () => ["note", "Q", "Q1", "Mind the margins."]],
];

/** A refusal for the session's role (main.ts's role checks and the review helper's gate). */
const ROLE_REFUSAL = /only (a|an|the) (worker|orchestrator|review helper|thinking partner|user)|a review helper only reads|a review helper does not/;

interface Usage { text: string; block: string }

/** The help's usage lines, each with its continuation lines (where a role mark may stand). */
function usages(help: string): Usage[] {
  const out: Usage[] = [];
  for (const line of help.split(/\r?\n/)) {
    if (/^ {2}nexus /.test(line)) out.push({ text: line.trim().replace(/ {3,}.*$/, ""), block: line });
    else if (out.length && /^ {3,}/.test(line)) out.at(-1)!.block += ` ${line.trim()}`;
    else if (!/^\s*$/.test(line)) out.push({ text: "", block: "" }); // a heading ends the block
  }
  return out.filter((u) => u.text);
}

/** The roles a usage's block marks it for: "(worker only)", "(orchestrator, or the step's review helper …)"; none: every role. */
function marked(block: string): Set<Who> | undefined {
  if (/\(orchestrator, or the step's review helper/.test(block)) return new Set(["orchestrator", "helper"]);
  const m = /\((?:the step's )?(worker|orchestrator|thinking partner|review helper) only\b/.exec(block);
  if (!m) return undefined;
  return new Set([({ worker: "worker", orchestrator: "orchestrator", "thinking partner": "conversation", "review helper": "helper" } as const)[m[1] as "worker"]]);
}

/** What a review helper may run, as the help's helper rule says. */
const helperMay = (args: string[]) => ["status", "help", "doc"].includes(args[0]!) || (args[0] === "review" && ["accept", "send-back", "pass-on", "decide", "ask-user"].includes(args[1]!));

async function call(who: Who, args: string[], input?: string): Promise<CliResult> {
  const { root, store } = project();
  const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_DIR: store.dir, NEXUS_HOME: join(root, "home") };
  if (who === "none") delete env.NEXUS_SESSION; else env.NEXUS_SESSION = SESSION[who];
  const stop = answering(store);
  try { return await cliRun(args.map((a) => a.replace("<root>", root)), { cwd: root, env, input }); } finally { stop(); }
}

test("each usage of nexus help is refused for a role exactly where the help marks it for others, and runs for the roles it names", async () => {
  const help = await helpText();
  assert.match(help, /a review helper's session runs only nexus status, nexus help, nexus doc and its nexus review accept\|send-back\|pass-on/, "the help states the helper rule");
  const lines = usages(help).filter((u) => !u.text.startsWith("nexus server "));
  const unmatched: string[] = [];
  const wrong: string[] = [];
  const table: string[] = [];
  for (const u of lines) {
    const entry = CALLS.find(([start]) => u.text.startsWith(start));
    if (!entry) { unmatched.push(u.text); continue; }
    const roles = marked(u.block);
    const row: string[] = [];
    for (const who of ROLES) {
      const args = entry[1]("<root>");
      const r = await call(who, args, entry[2]);
      const byRole = ROLE_REFUSAL.test(r.stderr);
      row.push(`${who}:${r.status === 0 ? "ok" : byRole ? "ROLE" : "other"}`);
      if (r.status === 1) wrong.push(`${u.text} as ${who}: a crash, not a usage error:\n${r.stderr}`);
      if (who === "none") {
        if (roles && r.status === 0) wrong.push(`${u.text}: marked for ${[...roles].join(", ")}, but ran without a session`);
        if (!roles && byRole) wrong.push(`${u.text}: refused for its role without a session: ${r.stderr.trim()}`);
        continue;
      }
      const allowed = (roles ? roles.has(who) : true) && (who !== "helper" || helperMay(args));
      if (allowed && byRole) wrong.push(`${u.text}: refused to a ${who}, whom the help lets run it: ${r.stderr.trim()}`);
      if (!allowed && !byRole) wrong.push(`${u.text}: not refused to a ${who} for its role (${r.status === 0 ? "it ran" : r.stderr.trim()})`);
    }
    table.push(`${u.text.slice(0, 60).padEnd(60)} ${row.join(" ")}`);
  }
  process.stdout.write(`# the role matrix (ok: ran; ROLE: refused for the role; other: refused for another reason)\n${table.map((l) => `# ${l}`).join("\n")}\n`);
  assert.deepEqual(unmatched, [], "every usage of the help has a call in CALLS");
  assert.deepEqual(wrong, []);
});

/**
 * Commands a briefing names as another role's, by role and words: the orchestrator's says workers record a metric's
 * values (nexus metric record) where it tells it to define metrics.
 */
const NAMED_FOR_OTHERS: [Who, string][] = [["orchestrator", "metric record"]];

/** The call of the usage a briefing's words name: "review add", or "check" for "nexus check <step> <name> --ok". */
function callFor(words: string): (typeof CALLS)[number] | undefined {
  const [w1, w2] = words.split(" ");
  const exact = CALLS.find(([start]) => start === `nexus ${words}`);
  if (exact) return exact;
  return CALLS.find(([start]) => {
    const h = start.split(" ");
    return h[1] === w1 && (w2 ? h[2] === w2 : h[2] !== undefined && h[2].startsWith("<"));
  });
}

test("no role is refused a command its own briefing names", async () => {
  const p = project().store.readProject();
  const briefings: [Exclude<Who, "none">, string][] = [
    ["worker", workerBriefing({ working: "en" })],
    ["orchestrator", orchestratorBriefing("P", 100_000)],
    ["conversation", partnerBriefing(p, undefined)],
    ["helper", helperBriefing(p)],
  ];
  const wrong: string[] = [];
  const checked = new Map<Who, number>();
  for (const [who, text] of briefings) {
    const named = new Set<string>();
    for (const m of text.matchAll(/nexus [a-z][a-z-]*(?: [^\s`"]+)*/g)) {
      const h = head(m[0]);
      const words = [h[0], h[1] && /^[a-z][a-z-]*$/.test(h[1]) ? h[1] : undefined].filter(Boolean).join(" ");
      named.add(words);
    }
    for (const words of named) {
      if (words.startsWith("server") || NAMED_FOR_OTHERS.some(([w, c]) => w === who && c === words)) continue;
      const entry = callFor(words);
      if (!entry) continue; // a command named without its subcommand ("nexus review"): no one usage to run
      const r = await call(who, entry[1]("<root>"), entry[2]);
      checked.set(who, (checked.get(who) ?? 0) + 1);
      if (ROLE_REFUSAL.test(r.stderr)) wrong.push(`the ${who}'s briefing names nexus ${words}, and it is refused: ${r.stderr.trim()}`);
    }
  }
  assert.deepEqual(wrong, []);
  for (const [who] of briefings) assert.ok((checked.get(who) ?? 0) >= 2, `the ${who}'s briefing: ${checked.get(who) ?? 0} commands run`);
});
