// What the fake runtimes (fake-claude.ts, fake-codex.ts) do with a message. A step turn's goal says
// "FAKE: <behaviour>":
//   done   report the step done              ask     ask a blocking question, then end the turn
//   noop   end the turn without an outcome   stop    report a stop condition
//   fail   report the step failed            slow    work for FAKE_SLOW_MS (default 1500), then done
// An answer ("[Nexus] Answer …") makes it report the current step done. As an orchestrator: "FAKE-DRAFT:" followed by
// YAML drafts that queue; "FAKE-NEXUS: [args]" runs `nexus` with those arguments; a "[Nexus] A worker asked … (qid X;"
// notice is answered with "fake answer". "FAKE-LONG" is answered with longReply("Reply"); a hand-over with
// longReply("SUMMARY").
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/cli/bin/nexus.js");

const nexus = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { env: process.env, stdio: "ignore" });
const nexusOut = (args: string[], input?: string): string => {
  try { return execFileSync(process.execPath, [CLI, ...args], { env: process.env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim(); }
  catch (e) { return `nexus failed: ${String((e as { stderr?: string }).stderr ?? e).trim()}`; }
};

/** Records what reached the agent and how, for the tests (FAKE_LOG, one JSON line each). */
export function record(text: string, priority: string | null, busy: boolean): void {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ text, priority, busy }) + "\n");
}

export interface Fake { step?: string }

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

/** Records how the runtime was started or asked (FAKE_ARGS, one JSON line each), for the tests. */
export function recordArgs(what: unknown): void {
  if (process.env.FAKE_ARGS) appendFileSync(process.env.FAKE_ARGS, JSON.stringify(what) + "\n");
}

/** Does what the message asks and returns the agent's reply. `tool` reports a shell command it ran. */
export async function respond(fake: Fake, text: string, tool: (command: string) => void): Promise<string> {
  const m = /step (\S+) \(\d+ of \d+\)/.exec(text);
  if (text.startsWith("[Nexus] Queue") && m) {
    const step = (fake.step = m[1]!);
    const behaviour = /FAKE: (\w+)/.exec(text)?.[1] ?? "done";
    nexus("step", "start", step);
    tool(`nexus step start ${step}`);
    if (behaviour === "slow") await new Promise((r) => setTimeout(r, Number(process.env.FAKE_SLOW_MS ?? 1500)));
    if (behaviour === "done" || behaviour === "slow") nexus("step", "done", step, "--summary", `fake finished ${step}`);
    if (behaviour === "fail") nexus("step", "failed", step, "--reason", "fake failure");
    if (behaviour === "stop") nexus("stop", step, "--condition", "fake condition", "--reason", "fake stop");
    if (behaviour === "ask") nexus("ask", "Which way?", "--step", step);
    return `step ${step}: ${behaviour}`;
  }
  if (text.startsWith("[Nexus] Answer") && fake.step) {
    nexus("step", "done", fake.step, "--summary", `fake finished ${fake.step} after an answer`);
    return "answered";
  }
  if (text.includes("hands this conversation to the orchestrator")) return longReply("SUMMARY");
  if (text.includes("FAKE-LONG")) return longReply("Reply");
  const draft = /FAKE-DRAFT:\s*\n([\s\S]*)$/.exec(text);
  if (draft) return nexusOut(["queue", "draft", "-"], draft[1]);
  const run = /FAKE-NEXUS: (\[.*\])/.exec(text);
  if (run) return nexusOut(JSON.parse(run[1]!) as string[]);
  const asked = /A worker asked[\s\S]*?\(qid (\S+);/.exec(text);
  if (asked) return nexusOut(["answer", asked[1]!, "fake answer", "--continue"]);
  return "ok"; // a nudge, a message sent while idle, anything else
}
