// What the fake runtimes (fake-claude.ts, fake-codex.ts) do with a message. A step turn's goal says
// "FAKE: <behaviour>":
//   done   report the step done              ask     ask a blocking question, then end the turn
//   noop   end the turn without an outcome   stop    report a stop condition
//   fail   report the step failed            slow    work for FAKE_SLOW_MS (default 1500), then done
//   stop1  report a stop condition the first time, done once the stop is lifted
//   slownoop  work for FAKE_SLOW_MS, then end the turn without an outcome (the step stays open)
//   slowask   work for FAKE_SLOW_MS, then ask a blocking question and end the turn
//   doneexit  report the step done, then the process exits on a signal before its turn ends
//   commit    commit a file named after the step in its working directory, then done
//   commitstop  the same commit, then a stop condition
//   background  start work in the background (a command) and end the turn without an outcome; the work ends after
//               FAKE_BG_MS (default 1500). Claude's fake then starts a turn by itself with the task's notification,
//               as Claude Code does; Codex's does not (Nexus nudges). Told of the end either way, it reports done.
//   bgagent     the same with a sub-agent in the background
//   bglong      the same command, running FAKE_BG_LONG_MS (default 600000): past the engine's limit in a test
//   review      write a picture and a note into <temp>/nexus-review/<step>/ (outside the working tree), add them with
//               nexus review add (the picture keyed, as a result), then done
// A failure of the runtime, then done: "<kind><n>" fails the step's first n turns (counted in a file beside
// FAKE_LOG, so a new process goes on counting), "<kind>" every turn. Kinds: overloaded, network (passing), auth
// (lasting), limit (a usage limit resetting FAKE_RESET_MS, default 1500, later), crash (the process exits mid-turn),
// cloudflare (an HTTP 403 page from Cloudflare, which the runtimes report as an authentication failure: passing).
// Each fake writes the failure the way its runtime does (fake-claude.ts, fake-codex.ts).
// "refused": the agent tries actions that are refused (each fake writes them as its runtime does), then done.
// "summary": done, then the step's context summary (`nexus context`); "summaryslow": the same, then FAKE_SLOW_MS before
// the turn ends. Nexus asking for the summary ("[Nexus] … write your context summary") gets one, unless
// FAKE_NO_SUMMARY is set. FAKE_CONTEXT_FILL (0 to 1) is the context fill each turn reports (default: claude 10 %,
// codex 6 %). A step turn may come after a seed (context care's first prompt of a fresh session): it is found at the
// start of any line.
// An answer ("[Nexus] Answer …") makes it report the current step done (also in a new process of the session: the
// step is kept in a file beside FAKE_LOG). As an orchestrator: "FAKE-DRAFT:" followed by
// YAML drafts that queue; "FAKE-NEXUS: [args]" runs `nexus` with those arguments; a "[Nexus] A worker asked … (qid X;"
// notice is answered with "fake answer"; with FAKE_REVIEW_ACCEPT set, a notice of a step waiting for its review is
// answered with `nexus review accept`. "FAKE-LONG" is answered with longReply("Reply"); a hand-over with
// longReply("SUMMARY"). "FAKE-SLOW" in a chat message: the turn works for FAKE_CHAT_SLOW_MS (default 4000), then
// replies "slow reply"; a stop (interrupt) ends it early. "FAKE-HISTORY": the reply lists every message the agent took
// in so far ("history: a | b"): the turns' messages and those read inside a turn (Claude's `next`, Codex's steer).
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/cli/bin/nexus.js");

const nexus = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { env: process.env, stdio: "ignore" });
const nexusOut = (args: string[], input?: string): string => {
  try { return execFileSync(process.execPath, [CLI, ...args], { env: process.env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim(); }
  catch (e) { return `nexus failed: ${String((e as { stderr?: string }).stderr ?? e).trim()}`; }
};

/** Records what reached the agent and how, for the tests (FAKE_LOG, one JSON line each). */
export function record(text: string, priority: string | null, busy: boolean): void {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ text, priority, busy, session: process.env.NEXUS_SESSION ?? null }) + "\n");
}

/** The context tokens a turn reports for a window of `window` tokens: FAKE_CONTEXT_FILL of it, else `fallback`. */
export function contextTokens(window: number, fallback: number): number {
  const fill = process.env.FAKE_CONTEXT_FILL;
  return fill ? Math.round(Number(fill) * window) : fallback;
}

export interface Fake {
  step?: string;
  /** Work this turn leaves running in the background, for the runtime's fake to report after the turn (see the header). */
  background?: { kind: "command" | "agent"; ms: number };
  /** Every message the agent took in, in order (FAKE-HISTORY shows them). */
  history?: string[];
}

/**
 * A command ("FAKE-NEXUS: [args]") in a message read during a turn (Claude's `next`, Codex's steer) is run before the
 * turn ends, as an agent acts on what it reads mid-turn; its output joins the reply. Without it, a command sent while
 * the orchestrator's fake answered a notice was lost, and the test waited in vain (queue TS1).
 */
export function actOnRead(read: readonly string[], reply: string): string {
  const outs = read.map((t) => /FAKE-NEXUS: (\[.*\])/.exec(t)).filter((m): m is RegExpExecArray => !!m).map((m) => nexusOut(JSON.parse(m[1]!) as string[]));
  return outs.length ? [reply, ...outs].join("\n\n") : reply;
}

/** Ends the running turn's FAKE-SLOW wait early (a stop: Claude's interrupt control, Codex's turn/interrupt). */
let interruptWait: (() => void) | undefined;
export function interrupt(): boolean {
  const f = interruptWait;
  interruptWait = undefined;
  f?.();
  return !!f;
}

/** Waits `ms`, or less when interrupted: true if it was. */
function interruptible(ms: number): Promise<boolean> {
  return new Promise((r) => {
    const t = setTimeout(() => { interruptWait = undefined; r(false); }, ms);
    interruptWait = () => { clearTimeout(t); r(true); };
  });
}

/** The first bytes of a 984×1600 PNG (a 492 px window at scale 2): all nexus review add reads of a picture. */
const PNG_492 = (() => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b);
  b.write("IHDR", 12, "ascii"); b.writeUInt32BE(984, 16); b.writeUInt32BE(1600, 20);
  return b;
})();

/** How Claude's fake starts the turn it starts by itself when background work ends (Claude Code: a task notification). */
export const BACKGROUND_NOTICE = "<task-notification>";

/** The text a stopped turn still writes after the interrupt (Claude Code does: a partial assistant message). */
export const PARTIAL = "partial text of the stopped turn";

export type FakeFailure = "overloaded" | "network" | "auth" | "limit" | "crash" | "cloudflare";

/** Whether this turn of the step fails, and how (see the header). */
function failure(step: string, behaviour: string): FakeFailure | undefined {
  const m = /^(overloaded|network|auth|limit|crash|cloudflare)(\d*)$/.exec(behaviour);
  if (!m) return undefined;
  if (!m[2]) return m[1] as FakeFailure;
  const file = join(dirname(process.env.FAKE_LOG ?? "."), `fake-fails-${step}`);
  const n = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
  if (n >= Number(m[2])) return undefined;
  writeFileSync(file, String(n + 1));
  return m[1] as FakeFailure;
}

/**
 * A long Markdown reply (over 3000 characters: headings, paragraphs, a list, a code block, non-ASCII letters), the
 * same every time, so a test can compare what reached a chat byte for byte.
 */
export function longReply(label: string): string {
  const parts = [`## ${label}: what the long reply covers`];
  for (let i = 1; i <= 8; i++) {
    parts.push(`Paragraph ${i}. The mining loop starts slowly on purpose: a player who digs the first shaft by hand learns where ore sits, why the walls need props, and when the water comes. Árvíztűrő tükörfúrógép ${i}. Every later tool only speeds up what the hand already knows.`);
    parts.push(`- Point ${i}.a: props cost wood, and wood is far.\n- Point ${i}.b: water rises one row per minute below the line.\n- Point ${i}.c: ore veins bend toward the old river bed.`);
  }
  parts.push("```ts\nconst shaft = dig({ depth: 12, props: true }); // the first shaft, by hand\n```");
  parts.push(`End of the ${label.toLowerCase()}: nothing after this line was cut.`);
  return parts.join("\n\n");
}

/**
 * Records how the runtime was started or asked (FAKE_ARGS, one JSON line each), for the tests, with what of its
 * environment the tests check (`handover`: NEXUS_HANDOVER, which no runtime may inherit).
 */
export function recordArgs(what: Record<string, unknown>): void {
  if (process.env.FAKE_ARGS) appendFileSync(process.env.FAKE_ARGS, JSON.stringify({ ...what, handover: process.env.NEXUS_HANDOVER ?? null }) + "\n");
}

/** A Write the runtime's --disallowedTools rules refuse (Claude's form for an absolute path: Write(//C:/x/**)). */
function writeDenied(path: string): boolean {
  const p = path.replaceAll("\\", "/").toLowerCase();
  return process.argv.flatMap((a) => a.split(",")).some((a) => {
    const m = /^Write\(\/\/(.+)\/\*\*\)$/.exec(a);
    return !!m && p.startsWith(m[1]!.toLowerCase() + "/");
  });
}

/**
 * Does what the message asks and returns the agent's reply, or the failure the runtime should show for this turn.
 * `tool` reports a shell command it ran.
 */
export async function respond(fake: Fake, text: string, tool: (command: string) => void, refused?: () => void): Promise<string | { fail: FakeFailure } | { exit: true } | { interrupted: true }> {
  const m = /step (\S+) \(\d+ of \d+\)/.exec(text);
  if (/(^|\n)\[Nexus\] Queue/.test(text) && m) {
    const step = (fake.step = m[1]!);
    // Kept beside FAKE_LOG too, so a new process of the session (after a restart) knows the step an answer is for.
    if (process.env.FAKE_LOG && process.env.NEXUS_SESSION) writeFileSync(join(dirname(process.env.FAKE_LOG), `fake-step-${process.env.NEXUS_SESSION}`), step);
    const behaviour = /FAKE: (\w+)/.exec(text)?.[1] ?? "done";
    nexus("step", "start", step);
    tool(`nexus step start ${step}`);
    const fail = failure(step, behaviour);
    if (fail) return { fail };
    if (/^(overloaded|network|auth|limit|crash|cloudflare)/.test(behaviour)) nexus("step", "done", step, "--summary", `fake finished ${step} after failures`);
    if (behaviour === "slow" || behaviour === "slownoop" || behaviour === "slowask") await new Promise((r) => setTimeout(r, Number(process.env.FAKE_SLOW_MS ?? 1500)));
    // "commit": a commit in the working directory (a file named after the step), then done.
    // "commitstop": the same commit, then a stop condition (as the worker briefing asks: commit, then stop).
    if (behaviour === "commit" || behaviour === "commitstop") {
      writeFileSync(join(process.cwd(), `${step}.txt`), `${step}\n`);
      const g = ["-c", "user.name=worker", "-c", "user.email=worker@example.invalid", "-c", "commit.gpgsign=false"];
      execFileSync("git", [...g, "add", `${step}.txt`], { stdio: "ignore" });
      execFileSync("git", [...g, "commit", "-q", "-m", `${step} work`], { stdio: "ignore" });
      if (behaviour === "commit") nexus("step", "done", step, "--summary", `fake committed ${step}`);
      else nexus("stop", step, "--condition", "fake condition", "--reason", "fake stop after a commit");
    }
    if (behaviour === "review") {
      const dir = join(tmpdir(), "nexus-review", step);
      mkdirSync(dir, { recursive: true });
      const shot = join(dir, `${step.toLowerCase()}-shot@492.png`), note = join(dir, "notes.md");
      writeFileSync(shot, PNG_492); writeFileSync(note, `# Review notes of ${step}
`);
      nexus("review", "add", step, shot, "--key", `${step.toLowerCase()}-shot@492`, "--role", "result", "--label", `${step} shot`);
      nexus("review", "add", step, note, "--label", `${step} notes`);
      nexus("step", "done", step, "--summary", `fake finished ${step} with review material`);
    }
    if (behaviour === "refused") { refused?.(); nexus("step", "done", step, "--summary", `fake finished ${step} without what was refused`); }
    if (["done", "slow", "summary", "summaryslow"].includes(behaviour)) nexus("step", "done", step, "--summary", `fake finished ${step}`);
    if (behaviour.startsWith("summary")) nexus("context", `fake summary of ${step}`, "--topics", "fake,context");
    if (behaviour === "summaryslow") await new Promise((r) => setTimeout(r, Number(process.env.FAKE_SLOW_MS ?? 1500)));
    if (behaviour === "fail") nexus("step", "failed", step, "--reason", "fake failure");
    if (behaviour === "doneexit") { nexus("step", "done", step, "--summary", `fake finished ${step}, then exits`); return { exit: true }; }
    if (behaviour === "stop") nexus("stop", step, "--condition", "fake condition", "--reason", "fake stop");
    // stop1: a stop condition on the step's first turn; once the stop is lifted, the step is done.
    if (behaviour === "stop1") {
      const file = join(dirname(process.env.FAKE_LOG ?? "."), `fake-stops-${step}`);
      if (existsSync(file)) nexus("step", "done", step, "--summary", `fake finished ${step} after the stop was lifted`);
      else { writeFileSync(file, "1"); nexus("stop", step, "--condition", "fake condition", "--reason", "fake stop"); }
    }
    if (behaviour === "ask" || behaviour === "slowask") nexus("ask", "Which way?", "--step", step);
    if (behaviour === "background" || behaviour === "bgagent" || behaviour === "bglong") {
      fake.background = { kind: behaviour === "bgagent" ? "agent" : "command", ms: Number(behaviour === "bglong" ? process.env.FAKE_BG_LONG_MS ?? 600_000 : process.env.FAKE_BG_MS ?? 1500) };
    }
    // The queue's last step done: the report, written where the prompt says (refused under a denied folder, as
    // Claude Code refuses a Write its --disallowedTools rule covers), then registered with nexus report.
    const report = /`nexus report (\S+) --file (\S+) --summary/.exec(text);
    if (report && behaviour === "done") {
      const path = resolve(report[2]!);
      if (!writeDenied(path)) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `# Queue ${report[1]} report\n\nfake report of the whole queue\n`);
        // Tests running side by side may share a project id and so a report file: a refusal here is not the test's subject.
        try { nexus("report", report[1]!, "--file", path, "--summary", `fake report of ${report[1]}`); } catch { /* another test took it */ }
      }
    }
    return `step ${step}: ${behaviour}`;
  }
  const stepFile = process.env.FAKE_LOG && process.env.NEXUS_SESSION ? join(dirname(process.env.FAKE_LOG), `fake-step-${process.env.NEXUS_SESSION}`) : undefined;
  fake.step ??= stepFile && existsSync(stepFile) ? readFileSync(stepFile, "utf8") : undefined;
  // Background work ended: Claude Code's own turn with the task's notification, or Nexus's nudge after it (Codex).
  if ((text.startsWith(BACKGROUND_NOTICE) || text.startsWith("[Nexus] The background work you started has finished")) && fake.step) {
    nexus("step", "done", fake.step, "--summary", `fake finished ${fake.step} after its background work`);
    return "background done";
  }
  if (text.startsWith("[Nexus] Answer") && fake.step) {
    nexus("step", "done", fake.step, "--summary", `fake finished ${fake.step} after an answer`);
    return "answered";
  }
  // A step sent back (by the orchestrator or the user's Fix it): work on it again and report it done.
  const back = /^\[Nexus\] The (?:orchestrator reviewed|user sent) step (\S+) of queue \S+ .*\(round (\d+)\)/.exec(text);
  if (back) {
    nexus("step", "start", back[1]!);
    nexus("step", "done", back[1]!, "--summary", `fake finished ${back[1]} round ${back[2]}`);
    return `round ${back[2]}`;
  }
  if (text.includes("write your context summary")) {
    if (!process.env.FAKE_NO_SUMMARY && fake.step) nexus("context", `fake summary of ${fake.step}, on request`, "--topics", "fake");
    return "summary";
  }
  if (text.includes("hands this conversation to the orchestrator")) return longReply("SUMMARY");
  if (text.includes("FAKE-LONG")) return longReply("Reply");
  if (text.includes("FAKE-SLOW")) {
    tool("sleep (FAKE-SLOW)");
    return (await interruptible(Number(process.env.FAKE_CHAT_SLOW_MS ?? 4000))) ? { interrupted: true } : "slow reply";
  }
  if (text.includes("FAKE-HISTORY")) return `history: ${(fake.history ?? []).join(" | ")}`;
  const draft = /FAKE-DRAFT:\s*\n([\s\S]*)$/.exec(text);
  if (draft) return nexusOut(["queue", "draft", "-"], draft[1]);
  const run = /FAKE-NEXUS: (\[.*\])/.exec(text);
  if (run) return nexusOut(JSON.parse(run[1]!) as string[]);
  const asked = /A worker asked[\s\S]*?\(qid (\S+);/.exec(text);
  if (asked) return nexusOut(["answer", asked[1]!, "fake answer", "--continue"]);
  // With FAKE_REVIEW_ACCEPT set, a step waiting for its review is accepted (tests about something other than review).
  const review = /\bStep (\S+) of queue (\S+) is done and waits for your review/.exec(text);
  if (review && process.env.FAKE_REVIEW_ACCEPT) return nexusOut(["review", "accept", review[2]!, review[1]!]);
  return "ok"; // a nudge, a message sent while idle, anything else
}
