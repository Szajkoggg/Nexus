// A stand-in for `codex app-server` (JSON-RPC over stdio), for testing without a model. It answers the methods Nexus
// uses and sends the notifications Nexus reads. What it does with a message is in fake-behaviour.ts; a turn/steer
// is recorded with priority "next", like Claude's mid-turn messages.
import { randomUUID } from "node:crypto";
import { record, recordArgs, respond, type Fake } from "./fake-behaviour.ts";

const out = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
const notify = (method: string, params: unknown) => out({ method, params });
const fake: Fake = {};
let threadId = "";
let turnId: string | undefined;

async function runTurn(id: string, text: string): Promise<void> {
  notify("turn/started", { threadId, turn: { id, status: "inProgress", items: [] } });
  const reply = await respond(fake, text, (command) =>
    notify("item/started", { threadId, turnId: id, item: { type: "commandExecution", id: randomUUID(), command: `"powershell.exe" -Command '${command}'`, status: "inProgress" } }));
  notify("item/completed", { threadId, turnId: id, item: { type: "agentMessage", id: randomUUID(), text: reply } });
  notify("thread/tokenUsage/updated", { threadId, turnId: id, tokenUsage: { last: { inputTokens: 120 }, total: { inputTokens: 120 }, modelContextWindow: 2000 } });
  turnId = undefined;
  notify("turn/completed", { threadId, turn: { id, status: "completed", items: [] } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d: string) => {
  buffer += d;
  let i: number;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line) as { id?: number; method?: string; params?: any };
    if (m.id === undefined || !m.method) continue; // notifications (initialized) and responses
    const reply = (result: unknown) => out({ id: m.id, result });
    const fail = (message: string) => out({ id: m.id, error: { code: -32000, message } });
    const text = () => (m.params?.input ?? []).map((x: { text?: string }) => x.text ?? "").join("\n");
    switch (m.method) {
      case "initialize": reply({ userAgent: "fake-codex" }); break;
      case "thread/start": recordArgs({ method: m.method, model: m.params.model, approvalsReviewer: m.params.approvalsReviewer ?? null, approvalPolicy: m.params.approvalPolicy, sandbox: m.params.sandbox, cwd: m.params.cwd }); threadId = randomUUID(); reply({ thread: { id: threadId }, model: "fake-codex-model" }); break;
      case "thread/resume": threadId = m.params.threadId; reply({ thread: { id: threadId }, model: "fake-codex-model" }); break;
      case "account/rateLimits/read":
        reply({ rateLimits: { primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 }, secondary: null } });
        break;
      case "turn/start": {
        recordArgs({ method: m.method, effort: m.params.effort ?? null });
        const t = text();
        record(t, null, !!turnId);
        if (turnId) { fail("a turn is already running"); break; }
        turnId = randomUUID();
        reply({ turn: { id: turnId, status: "inProgress", items: [] } });
        void runTurn(turnId, t);
        break;
      }
      case "turn/steer":
        record(text(), "next", !!turnId);
        if (!turnId || m.params.expectedTurnId !== turnId) fail("no active turn");
        else reply({ turnId });
        break;
      case "turn/interrupt": reply({}); break;
      default: fail(`fake-codex does not implement ${m.method}`);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
