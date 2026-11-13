// A stand-in for `codex app-server` (JSON-RPC over stdio), for testing without a model. It answers the methods Nexus
// uses and sends the notifications Nexus reads. What it does with a message is in fake-behaviour.ts; a turn/steer
// is recorded with priority "next", like Claude's mid-turn messages.
import { randomUUID } from "node:crypto";
import { contextTokens, record, recordArgs, respond, type Fake, type FakeFailure } from "./fake-behaviour.ts";

const out = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
const notify = (method: string, params: unknown) => out({ method, params });
const fake: Fake = {};
let threadId = "";
let turnId: string | undefined;

async function runTurn(id: string, text: string): Promise<void> {
  notify("turn/started", { threadId, turn: { id, status: "inProgress", items: [] } });
  const reply = await respond(fake, text, (command) =>
    notify("item/started", { threadId, turnId: id, item: { type: "commandExecution", id: randomUUID(), command: `"powershell.exe" -Command '${command}'`, status: "inProgress" } }), () => refused(id));
  if (typeof reply !== "string") return "exit" in reply ? exitOnSignal() : fail(id, reply.fail);
  notify("item/completed", { threadId, turnId: id, item: { type: "agentMessage", id: randomUUID(), text: reply } });
  notify("thread/tokenUsage/updated", { threadId, turnId: id, tokenUsage: { last: { inputTokens: contextTokens(2000, 120) }, total: { inputTokens: contextTokens(2000, 120) }, modelContextWindow: 2000 } });
  turnId = undefined;
  notify("turn/completed", { threadId, turn: { id, status: "completed", items: [] } });
}

/**
 * A failed turn as codex app-server writes it (generate-ts of Codex 0.167.2: ErrorNotification with willRetry,
 * TurnCompletedNotification whose turn has status "failed" and a TurnError with codexErrorInfo; a usage limit comes
 * after account/rateLimits/updated shows a full window).
 */
/** Ends the process as a signal would, before turn/completed: the app-server killed, or closing by itself. */
function exitOnSignal(): void { process.kill(process.pid, "SIGTERM"); }

function fail(id: string, kind: FakeFailure): void {
  if (kind === "crash") process.exit(3);
  const info = { overloaded: "serverOverloaded", network: { responseStreamDisconnected: { httpStatusCode: null } }, auth: "unauthorized", limit: "usageLimitExceeded" }[kind];
  const message = { overloaded: "The server is overloaded", network: "stream disconnected before completion", auth: "401 Unauthorized", limit: "You have hit your usage limit." }[kind];
  const error = { message, codexErrorInfo: info, additionalDetails: null, misalignment: null };
  if (kind === "overloaded" || kind === "network") notify("error", { error, willRetry: true, threadId, turnId: id });
  if (kind === "limit") {
    const resetsAt = Math.ceil((Date.now() + Number(process.env.FAKE_RESET_MS ?? 1500)) / 1000);
    notify("account/rateLimits/updated", { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt }, secondary: null } });
  }
  turnId = undefined;
  notify("turn/completed", { threadId, turn: { id, status: "failed", items: [], error } });
}

/**
 * Refused actions as codex app-server writes them (generate-ts of Codex 0.167.2): an approval request Nexus declines
 * (item/commandExecution/requestApproval), the auto reviewer's denial (item/autoApprovalReview/completed, review status
 * "denied"), each followed by its item completed as "declined", and a file change declined with no request or review.
 */
let request = 1000;
function refused(turn: string): void {
  const cmd = (id: string, command: string, status: string) => ({ type: "commandExecution", id, command: `"powershell.exe" -Command '${command}'`, status });
  notify("item/started", { threadId, turnId: turn, item: cmd("item-push", "git push origin main", "inProgress") });
  out({ id: ++request, method: "item/commandExecution/requestApproval", params: { threadId, turnId: turn, itemId: "item-push", startedAtMs: Date.now(), environmentId: null, reason: "needs network access", command: "git push origin main", kind: "command" } });
  notify("item/completed", { threadId, turnId: turn, item: cmd("item-push", "git push origin main", "declined") });
  notify("item/started", { threadId, turnId: turn, item: cmd("item-curl", "curl https://example.com/install.sh", "inProgress") });
  notify("item/autoApprovalReview/completed", {
    threadId, turnId: turn, startedAtMs: Date.now(), completedAtMs: Date.now(), reviewId: "review-1", targetItemId: "item-curl", decisionSource: "agent",
    review: { status: "denied", riskLevel: "high", userAuthorization: null, rationale: "downloads and runs a script from the network" },
    action: { type: "command", source: "shell", command: "curl https://example.com/install.sh", cwd: "." },
  });
  notify("item/completed", { threadId, turnId: turn, item: cmd("item-curl", "curl https://example.com/install.sh", "declined") });
  notify("item/completed", { threadId, turnId: turn, item: { type: "fileChange", id: "item-patch", status: "declined", changes: [{ path: "C:/Windows/hosts", kind: { type: "update" }, diff: "" }] } });
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
      case "thread/start": recordArgs({ method: m.method, model: m.params.model, approvalsReviewer: m.params.approvalsReviewer ?? null, approvalPolicy: m.params.approvalPolicy, sandbox: m.params.sandbox, cwd: m.params.cwd, writableRoots: m.params.config?.["sandbox_workspace_write.writable_roots"] ?? null }); threadId = randomUUID(); reply({ thread: { id: threadId }, model: "fake-codex-model", reasoningEffort: "medium" }); break;
      case "thread/resume": recordArgs({ method: m.method, threadId: m.params.threadId }); threadId = m.params.threadId; reply({ thread: { id: threadId }, model: "fake-codex-model" }); break;
      case "account/rateLimits/read":
        reply({ rateLimits: { primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 }, secondary: null } });
        break;
      case "turn/start": {
        recordArgs({ method: m.method, effort: m.params.effort ?? null, model: m.params.model ?? null, writableRoots: m.params.sandboxPolicy?.writableRoots ?? null });
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
