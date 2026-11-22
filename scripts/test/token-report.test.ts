// The token report (scripts/token-report.ts): made-up Claude Code and Codex transcripts, turn records and events, and
// every breakdown checked against values worked out by hand; the period filter; and the files found on disk (only the
// project's transcripts, sub-agents' included, read from temporary folders, never the machine's own).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnRecord } from "@nexus/protocol";
import { analyze, readOnly, readPaths, relativePath, render, segments, type EventLine, type Input, type SessionInfo } from "../token-report/analysis.ts";
import { execTools, parseClaude, parseCodex, type ToolUse } from "../token-report/transcripts.ts";
import { load } from "../token-report.ts";

const ROOT = "C:/Code/Proj";
const CWD = "C:\\Code\\Proj.worktrees\\Q";
const at = (time: string) => `2026-11-17T${time}Z`;

// ---------------------------------------------------------------- made-up transcripts

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number) =>
  ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite });
const tool = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input });
const assistant = (id: string, time: string, u: object, content: object[], cwd = CWD) =>
  JSON.stringify({ type: "assistant", timestamp: at(time), cwd, message: { id, model: "claude-opus-5-5", usage: u, content } });
const result = (time: string, id: string, content: unknown) =>
  JSON.stringify({ type: "user", timestamp: at(time), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } });

/** The worker's Claude Code transcript: four calls, the third after an idle hour and a half. */
const workerClaude = [
  JSON.stringify({ type: "queue-operation", cwd: CWD }),
  // A: two reads at once (a whole response is several lines with one message id).
  assistant("msg_a", "10:00:00", usage(0, 0, 100_000, 0), [{ type: "thinking" }]),
  assistant("msg_a", "10:00:00", usage(0, 0, 100_000, 0), [tool("t1", "Read", { file_path: "C:\\Code\\Proj.worktrees\\Q\\docs\\PROTOCOL.md" })]),
  assistant("msg_a", "10:00:01", usage(0, 0, 100_000, 0), [tool("t2", "Bash", { command: "cat README.md 2>/dev/null" })]),
  result("10:00:02", "t1", "x".repeat(400)),
  result("10:00:02", "t2", [{ type: "text", text: "y".repeat(800) }]),
  // B: the checks and the full suite.
  assistant("msg_b", "10:01:00", usage(0, 0, 400_000, 0), [tool("t3", "Bash", { command: "npm run typecheck && npm test" })]),
  result("10:05:00", "t3", "ok"),
  // A synthetic message is no model call.
  JSON.stringify({ type: "assistant", timestamp: at("10:06:00"), message: { id: "msg_syn", model: "<synthetic>", usage: usage(9, 9, 9, 9), content: [] } }),
  // C: after 2.5 hours the cache is written again.
  assistant("msg_c", "12:30:30", usage(0, 0, 0, 8_000), [tool("t4", "Bash", { command: 'nexus step progress Q1 "half way"' })]),
  result("12:30:31", "t4", "ok: step.progress"),
  // D: an image read back, and a look at a background run that waits for the lock.
  assistant("msg_d", "12:31:30", usage(1_000, 0, 0, 0), [tool("t5", "Read", { file_path: "C:/tmp/shot.png" }), tool("t6", "TaskOutput", { task_id: "b1" })]),
  result("12:31:31", "t5", [{ type: "image", source: {} }]),
  result("12:31:31", "t6", "npm test: waiting for C:\\Code\\Other (1 of at most 15 min)"),
].join("\n");

/** The orchestrator's: a run of two read-only calls. Its sub-agent's: one Grep. */
const orchestratorClaude = [
  assistant("msg_f", "11:00:00", usage(0, 1_000, 600_000, 0), [tool("t7", "Bash", { command: "nexus status" })], ROOT),
  result("11:00:01", "t7", "status"),
  assistant("msg_f2", "11:00:30", usage(0, 0, 0, 0), [tool("t8", "Read", { file_path: "C:/Code/Proj/AGENTS.md" })], ROOT),
  result("11:00:31", "t8", "z".repeat(40)),
].join("\n");
const orchestratorSub = assistant("msg_g", "11:05:00", usage(2_000, 0, 0, 0), [tool("t9", "Grep", { pattern: "x", path: "src" })], ROOT);
/** A session started by hand in the project (no Nexus session names it), and one of another project. */
const unnamed = assistant("msg_h", "13:00:00", usage(3_000, 0, 0, 0), [tool("t10", "Bash", { command: "npm run lint" })], ROOT);
const elsewhere = assistant("msg_i", "13:00:00", usage(1_000_000, 0, 0, 0), [], "C:\\Code\\Other");

/** The worker's Codex transcript: one exec cell running two reads. */
const workerCodex = [
  JSON.stringify({ timestamp: at("08:59:00"), type: "session_meta", payload: { id: "c-1", cwd: CWD } }),
  JSON.stringify({ timestamp: at("08:59:01"), type: "turn_context", payload: { model: "gpt-6-astra" } }),
  JSON.stringify({ timestamp: at("09:00:00"), type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "call_1", input: 'text(await tools.exec_command({cmd:"git log --oneline -5"}));\ntext(await tools.exec_command({cmd:"sed -n \'1,50p\' docs/PROTOCOL.md"}));' } }),
  JSON.stringify({ timestamp: at("09:00:00"), type: "token_usage_record", payload: { response_id: "resp_1", usage: { input_tokens: 10_000, cached_input_tokens: 10_000, cache_write_input_tokens: 0, output_tokens: 0 } } }),
  JSON.stringify({ timestamp: at("09:00:05"), type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_1", output: [{ type: "input_text", text: "w".repeat(200) }] } }),
].join("\n");
/** Codex's guardian reviewing one of that worker's approvals: a sub-agent thread naming its parent, elsewhere. */
const guardianCodex = [
  JSON.stringify({ timestamp: at("09:00:02"), type: "session_meta", payload: { id: "g-1", parent_thread_id: "c-1", cwd: "C:\\Temp\\elsewhere", source: { subagent: { other: "guardian" } } } }),
  JSON.stringify({ timestamp: at("09:00:03"), type: "token_usage_record", payload: { response_id: "resp_g", usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 0 } } }),
].join("\n");

const sessions: SessionInfo[] = [
  { id: "S-w", project: "p", role: "worker", runtime: "claude", native_id: "w-1" },
  { id: "S-c", project: "p", role: "worker", runtime: "codex", native_id: "c-1" },
  { id: "S-o", project: "p", role: "orchestrator", runtime: "claude", native_id: "o-1" },
  { id: "S-o2", project: "p", role: "orchestrator", runtime: "codex", native_id: "o-2" },
  { id: "user", project: "p", role: "user", runtime: "external", native_id: null },
];

const turn = (session: string, role: TurnRecord["role"], runtime: TurnRecord["runtime"], start: string, end: string, tokens: TurnRecord["tokens"], project = "p"): TurnRecord =>
  ({ v: 1, at: at(end), started_at: at(start), project, session, role, runtime, outcome: "ok", tokens });
const turns: TurnRecord[] = [
  turn("S-w", "worker", "claude", "10:00:00", "10:05:00", { input: 0, output: 0, cache_read: 500_000, cache_creation: 0 }),
  turn("S-w", "worker", "claude", "12:30:00", "12:35:00", { input: 0, output: 0, cache_read: 0, cache_creation: 8_000 }),
  turn("S-o2", "orchestrator", "codex", "10:59:00", "11:00:00", { input: 1_000, output: 0, cache_read: 0, cache_creation: 0 }),
  turn("S-x", "worker", "claude", "11:00:00", "11:01:00", { input: 1_000_000, output: 0, cache_read: 0, cache_creation: 0 }, "q"),
];

let n = 0;
const ev = (type: string, time: string, session: string, queue: string, step: string, more: Partial<EventLine> = {}): EventLine =>
  ({ type, at: at(time), session, queue, step, ...more, ...{ id: `e${n++}` } });
const events: EventLine[] = [
  ev("review.sent_back", "10:10:00", "S-o", "Q", "Q1"),
  ev("check.result", "11:00:00", "S-w", "Q", "Q1", { name: "npm test", ok: false }),
  ev("check.result", "11:10:00", "S-w", "Q", "Q1", { name: "npm test", ok: true }),
  ev("step.done", "11:20:00", "S-w", "Q", "Q1"),
  ev("step.done", "11:30:00", "S-w", "Q", "Q1"),
  ev("check.result", "11:40:00", "S-w", "Q", "Q2", { name: "npm run lint", ok: false }),
  ev("step.done", "11:41:00", "S-w", "Q", "Q2"),
  ev("review.sent_back", "11:50:00", "user", "Q", "Q2"),
  ev("review.commented", "11:51:00", "user", "Q", "Q2", { to: "send_back" }),
  ev("review.commented", "11:52:00", "user", "Q", "Q2", { to: "note" }),
  ev("review.rejected", "11:53:00", "user", "R", "R1"),
  ev("review.provisional", "11:54:00", "S-o", "R", "R2"),
  ev("review.fix_asked", "11:55:00", "user", "R", "R2"),
];

function input(more: Partial<Input> = {}): Input {
  return {
    transcripts: [
      parseClaude(workerClaude, { session: "w-1", subagent: false }),
      parseClaude(orchestratorClaude, { session: "o-1", subagent: false }),
      parseClaude(orchestratorSub, { session: "o-1", subagent: true }),
      parseClaude(unnamed, { session: "u-1", subagent: false }),
      parseClaude(elsewhere, { session: "x-1", subagent: false }),
      parseCodex(workerCodex),
    ],
    turns, events, sessions, roots: [ROOT], projects: ["p"], ...more,
  };
}

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

// ---------------------------------------------------------------- the readers

test("a Claude Code transcript: one call per response, its tools and what came back, no synthetic message", () => {
  const t = parseClaude(workerClaude, { session: "w-1", subagent: false });
  assert.equal(t.cwd, CWD);
  assert.deepEqual(t.calls.map((c) => c.id), ["msg_a", "msg_b", "msg_c", "msg_d"]);
  const a = t.calls[0]!;
  assert.deepEqual(a.tokens, { input: 0, output: 0, cache_read: 100_000, cache_creation: 0 });
  assert.deepEqual(a.tools.map((x) => [x.name, x.result_chars]), [["Read", 400], ["Bash", 800]]);
  const d = t.calls[3]!;
  assert.deepEqual(d.tools.map((x) => [x.name, x.images, x.lock_wait]), [["Read", 1, false], ["TaskOutput", 0, true]]);
});

test("a Codex transcript: input less cached, the exec cell's tools, its output shared among them", () => {
  const t = parseCodex(workerCodex);
  assert.equal(t.session, "c-1");
  assert.equal(t.calls.length, 1);
  const c = t.calls[0]!;
  assert.equal(c.model, "gpt-6-astra");
  assert.deepEqual(c.tokens, { input: 0, output: 0, cache_read: 10_000, cache_creation: 0 });
  assert.deepEqual(c.tools.map((x) => [x.name, x.command, x.result_chars]), [
    ["exec_command", "git log --oneline -5", 100], ["exec_command", "sed -n '1,50p' docs/PROTOCOL.md", 100],
  ]);
  const guardian = parseCodex(guardianCodex);
  assert.deepEqual([guardian.session, guardian.subagent], ["c-1", true]);
  assert.deepEqual(execTools('image((await tools.view_image({path:"C:/a.png"})).image_url);').map((x) => [x.name, x.path]), [["view_image", "C:/a.png"]]);
});

test("an older Codex transcript without usage records counts its token_count events, a repeated one once", () => {
  const count = (time: string, total: number, last: number) =>
    JSON.stringify({ timestamp: at(time), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: total }, last_token_usage: { input_tokens: last, cached_input_tokens: 0, output_tokens: 1 } } } });
  const t = parseCodex([JSON.stringify({ type: "session_meta", payload: { id: "old" } }), count("09:00:00", 5, 5), count("09:00:01", 5, 5), count("09:01:00", 12, 7)].join("\n"));
  assert.deepEqual(t.calls.map((c) => c.tokens.input), [5, 7]);
});

test("what a tool call reads, and whether it only reads", () => {
  const sh = (command: string): ToolUse => ({ name: "Bash", command, result_chars: 0, images: 0, lock_wait: false });
  assert.deepEqual(segments("A=1 npm test 2>&1 | tail -5; git status && echo ok"), ["npm test 2>&1", "tail -5", "git status", "echo ok"]);
  assert.equal(readOnly(sh("git -C C:/x log --oneline | head")), true);
  assert.equal(readOnly(sh("git commit -m x")), false);
  assert.equal(readOnly(sh("sed -i 's/a/b/' f.ts")), false);
  assert.equal(readOnly(sh("cat > f.ts <<'EOF'")), false);
  assert.equal(readOnly(sh("nexus status")), true);
  assert.equal(readOnly(sh("nexus step done Q1")), false);
  assert.deepEqual(readPaths(sh("sed -n '10,20p' docs/DESIGN.md; head -n 40 README.md")), ["docs/DESIGN.md", "README.md"]);
  assert.deepEqual(readPaths({ ...sh("Get-Content -TotalCount 30 apps\\x.ts"), name: "PowerShell" }), ["apps\\x.ts"]);
  assert.equal(relativePath("/c/Code/Proj.worktrees/TB/docs/X.md", [ROOT]), "docs/X.md");
  assert.equal(relativePath("C:\\Code\\Proj\\README.md", [ROOT]), "README.md");
});

// ---------------------------------------------------------------- the breakdowns

test("every breakdown over the whole data comes out at the values worked out by hand", () => {
  const r = analyze(input());
  // Weighted, each call with its runtime's weights (a Claude Code cache read 0.02, a Codex one 0.1): worker 2,000 + 8,000
  // + 10,000 + 1,000 + Codex 1,000; orchestrator 5,000 + 12,000 + 0 + sub-agent 2,000; other 3,000.
  close(r.total_weighted, 44_000);
  const role = (x: string) => r.roles.find((y) => y.role === x)!;
  assert.deepEqual(r.roles.map((x) => x.role), ["worker", "orchestrator", "other"]);
  const w = role("worker");
  assert.equal(w.calls, 5);
  assert.equal(w.sessions, 2);
  close(w.weighted, 22_000);
  close(w.share, 22_000 / 44_000);
  close(w.cache_read_share, (500_000 * 0.02 + 10_000 * 0.1) / 22_000);
  close(w.avg_context, 519_000 / 5);
  close(w.above["300000"], 400_000 / 519_000);
  close(w.above["500000"], 0);
  const o = role("orchestrator");
  assert.deepEqual([o.calls, o.sessions], [3, 1]);
  close(o.weighted, 19_000);
  close(o.above["500000"], 600_000 / 602_000);
  close(role("other").weighted, 3_000);

  // The idle hour: call C's cache writes, 8,000 × 1.25.
  assert.deepEqual([r.idle.calls, r.idle.transcripts], [1, 1]);
  close(r.idle.weighted, 10_000);
  close(r.idle.share, 10_000 / 44_000);
  assert.deepEqual(Object.keys(r.idle.by_role), ["worker"]);

  // Routine work: B tests, H's lint, D waited for the lock.
  assert.deepEqual([r.routine.tests.calls, r.routine.checks.calls, r.routine.build.calls, r.routine.lock_wait.calls], [1, 1, 0, 1]);
  close(r.routine.tests.share, 8_000 / 44_000);
  close(r.routine.checks.weighted, 3_000);
  close(r.routine.lock_wait.weighted, 1_000);
  assert.deepEqual([r.routine.full_test_runs, r.routine.lock_queries], [1, 1]);
  assert.deepEqual(r.images, { images: 1, calls: 1 });
  assert.equal(r.step_progress, 1);

  // Files: PROTOCOL.md by Read (400 chars) and by Codex's sed (its half of 200); README.md by cat; AGENTS.md by Read;
  // the picture by Read (no text).
  assert.deepEqual(r.reads, [
    { path: "docs/PROTOCOL.md", count: 2, tokens: 125 },
    { path: "README.md", count: 1, tokens: 200 },
    { path: "AGENTS.md", count: 1, tokens: 10 },
    { path: "C:/tmp/shot.png", count: 1, tokens: 0 },
  ]);

  // Shape: the worker's A, D and E made several tool calls, A and E only read; the orchestrator's F and F2 are a run.
  const ws = r.shapes.find((s) => s.role === "worker")!;
  assert.deepEqual([ws.calls, ws.multi_tool, ws.read_only], [5, 3, 2]);
  close(ws.multi_share, 0.6);
  close(ws.read_only_share, 0.4);
  close(ws.read_only_weighted_share, 3_000 / 22_000);
  const os = r.shapes.find((s) => s.role === "orchestrator")!;
  assert.deepEqual([os.multi_tool, os.read_only, os.runs], [0, 3, { "2": 1, "3": 0, "4-5": 0, "6+": 0 }]);

  // Turns: project q's left out; the second worker turn began over an hour after the first ended.
  assert.deepEqual(r.turns.rows.map((x) => [x.role, x.runtime, x.turns, x.weighted]), [["worker", "claude", 2, 20_000], ["orchestrator", "codex", 1, 1_000]]);
  close(r.turns.rows[0]!.cache_read_share, 10_000 / 20_000);
  assert.deepEqual([r.turns.idle.turns, r.turns.idle.weighted], [1, 10_000]);

  // Quality.
  assert.deepEqual(r.quality.total, { steps_done: 2, fix_it: 2, rejected: 1, provisional: 1, provisional_returned: 1, send_backs: 1, check_fails: 2, check_fix_rounds: 1 });
  assert.deepEqual(r.quality.queues.map((q) => [q.queue, q.steps_done, q.fix_it, q.send_backs, q.check_fails, q.rejected, q.provisional_returned]), [["Q", 2, 2, 1, 2, 0, 0], ["R", 0, 0, 0, 0, 1, 1]]);
  assert.deepEqual(r.quality.steps.map((s) => `${s.queue}/${s.step}`), ["Q/Q1", "Q/Q2", "R/R1", "R/R2"]);

  // Gaps: the unnamed transcript, the Codex orchestrator with turns but no transcript, the calls before the turns.
  assert.equal(r.gaps.length, 3);
  assert.match(r.gaps[0]!, /^1 transcript\(s\) .* 1 call\(s\)/);
  assert.match(r.gaps[1]!, /^1 orchestrator \(codex\) session\(s\) .* 4\.8% /);
  assert.match(r.gaps[2]!, /^Transcripts reach back to 2026-11-17T09:00:00Z, turns\.jsonl only to 2026-11-17T10:05:00Z/);
  assert.deepEqual(r.sources, { claude_transcripts: 3, codex_transcripts: 1, subagents: 1, turns: 3, events: 13 });

  const md = render(r, ["somewhere"]);
  assert.match(md, /\| worker \| 2 \| 5 \| 22\.0k \| 50\.0% \|/);
  assert.match(md, /TOKEN_WEIGHTS: claude: input 1, output 5, cache write 1\.25, cache read 0\.02; codex: input 1, output 5, cache write 1\.25, cache read 0\.1; any other runtime: input 1, output 5, cache write 1\.25, cache read 0\.1\)/);
  assert.match(md, /## Gaps/);
});

test("the period: only its calls, turns and events count, an idle gap that began before it still counts", () => {
  const r = analyze(input({ since: at("10:30:00"), until: at("12:40:00") }));
  // In it: the worker's C and D, the orchestrator's F, F2 and G; not A, B (before), E (09:00) or H (13:00).
  assert.deepEqual(r.roles.map((x) => [x.role, x.calls, x.weighted]), [["worker", 2, 11_000], ["orchestrator", 3, 19_000]]);
  close(r.total_weighted, 30_000);
  assert.equal(r.idle.calls, 1);
  assert.deepEqual([r.routine.tests.calls, r.routine.full_test_runs, r.routine.lock_queries], [0, 0, 1]);
  assert.deepEqual(r.reads.map((f) => f.path), ["AGENTS.md", "C:/tmp/shot.png"]);
  assert.deepEqual(r.turns.rows.map((x) => [x.role, x.turns]), [["worker", 1], ["orchestrator", 1]]);
  assert.equal(r.turns.idle.turns, 1);
  assert.equal(r.quality.total.send_backs, 0);
  assert.equal(r.quality.total.steps_done, 2);
  assert.deepEqual(r.span.calls, [at("11:00:00"), at("12:31:30")]);
});

test("the files on disk: the project's transcripts and their sub-agents, not another project's", () => {
  const tmp = mkdtempSync(join(tmpdir(), "nexus-token-report-"));
  const root = join(tmp, "Proj").replace(/\\/g, "/");
  const home = join(tmp, "home");
  const claude = join(tmp, "claude");
  const codex = join(tmp, "codex");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "projects.yaml"), `protocol: 1\nprojects:\n  - id: p\n    root: ${root}\n`);
  writeFileSync(join(home, "turns.jsonl"), turns.map((t) => JSON.stringify(t)).join("\n") + "\n");
  for (const s of sessions) {
    const dir = join(root, ".nexus", "sessions", s.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.yaml"), `protocol: 1\nid: ${s.id}\nproject: p\nrole: ${s.role}\nruntime: ${s.runtime}\nnative_id: ${s.native_id ?? "null"}\ncwd: ${root}\n`);
  }
  writeFileSync(join(root, ".nexus", "sessions", "S-w", "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  // Claude Code's folders: the project's own (named after its root), a worktree's, and another project's.
  const folder = root.replace(/[^A-Za-z0-9]/g, "-");
  mkdirSync(join(claude, `${folder}-worktrees-Q`), { recursive: true });
  mkdirSync(join(claude, folder, "o-1", "subagents"), { recursive: true });
  mkdirSync(join(claude, "C--Code-Other"), { recursive: true });
  writeFileSync(join(claude, `${folder}-worktrees-Q`, "w-1.jsonl"), workerClaude);
  writeFileSync(join(claude, folder, "o-1.jsonl"), orchestratorClaude);
  writeFileSync(join(claude, folder, "o-1", "subagents", "agent-a1.jsonl"), orchestratorSub);
  writeFileSync(join(claude, "C--Code-Other", "x-1.jsonl"), elsewhere);
  mkdirSync(join(codex, "2026", "11", "17"), { recursive: true });
  writeFileSync(join(codex, "2026", "11", "17", "rollout-a.jsonl"), workerCodex);
  writeFileSync(join(codex, "2026", "11", "17", "rollout-g.jsonl"), guardianCodex);
  writeFileSync(join(codex, "2026", "11", "17", "rollout-b.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: "zz", cwd: "C:\\Code\\Other" } }));

  const { report, sources } = load({ claudeDir: claude, codexDir: codex, nexusHome: home });
  assert.deepEqual(report.projects, ["p"]);
  assert.deepEqual(report.sources, { claude_transcripts: 2, codex_transcripts: 1, subagents: 2, turns: 3, events: 13 });
  close(report.total_weighted, 22_000 + 19_000 + 500);
  assert.match(sources[0]!, /\(3 transcript files/);
  assert.match(sources[1]!, /\(2 transcript files/);
});
