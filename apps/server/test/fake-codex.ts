// A stand-in for `codex app-server` (JSON-RPC over stdio), for testing without a model. It answers the methods Nexus
// uses and sends the notifications Nexus reads. What it does with a message is in fake-behaviour.ts; a turn/steer
// is recorded with priority "next", like Claude's mid-turn messages.
import { randomUUID } from "node:crypto";
import { PARTIAL, actOnRead, contextTokens, interrupt, record, recordArgs, respond, type Fake, type FakeFailure } from "./fake-behaviour.ts";

const out = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
const notify = (method: string, params: unknown) => out({ method, params });
const fake: Fake = { history: [] };
/** Messages steered into the running turn, not taken in yet: taken in at its end, dropped by an interrupt (as Codex does). */
let steered: string[] = [];
let threadId = "";
let turnId: string | undefined;
/** The thread's running token total, as codex app-server reports it in every tokenUsage update. */
const total = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
let turns = 0;
/** One model request's figures (`last`), added to the running total, as thread/tokenUsage/updated. */
function tokens(turn: string, last: { inputTokens: number; cachedInputTokens: number; outputTokens: number }): void {
  const l = { cacheWriteInputTokens: 0, reasoningOutputTokens: 0, ...last, totalTokens: last.inputTokens + last.outputTokens };
  for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += l[k];
  notify("thread/tokenUsage/updated", { threadId, turnId: turn, tokenUsage: { last: l, total: { ...total }, modelContextWindow: 2000 } });
}

/** A message taken into the thread, reported as Codex does (item/started and item/completed of a userMessage). */
function takeIn(turn: string, text: string): void {
  const item = { type: "userMessage", id: randomUUID(), content: [{ type: "text", text, text_elements: [] }] };
  notify("item/started", { threadId, turnId: turn, item });
  notify("item/completed", { threadId, turnId: turn, item });
  fake.history!.push(text);
}

async function runTurn(id: string, text: string): Promise<void> {
  notify("turn/started", { threadId, turn: { id, status: "inProgress", items: [] } });
  takeIn(id, text);
  const first = await respond(fake, text, (command) => {
    const item = { type: "commandExecution", id: randomUUID(), command: `"powershell.exe" -Command '${command}'`, status: "inProgress" };
    notify("item/started", { threadId, turnId: id, item });
    notify("item/completed", { threadId, turnId: id, item: { ...item, status: "completed", exitCode: 0 } });
  }, () => refused(id));
  if (typeof first !== "string") return "exit" in first ? exitOnSignal() : "interrupted" in first ? interrupted(id) : fail(id, first.fail);
  for (const s of steered) takeIn(id, s);
  const reply = actOnRead(steered, first);
  steered = [];
  notify("item/completed", { threadId, turnId: id, item: { type: "agentMessage", id: randomUUID(), text: reply } });
  // Two model requests per turn, each with its `last` and the thread's running `total` (checked live). Turn n:
  // 100n input of which 60n cached and 3n output, then the context's fill (120) of which 50 cached and 2n output.
  const n = ++turns;
  tokens(id, { inputTokens: 100 * n, cachedInputTokens: 60 * n, outputTokens: 3 * n });
  tokens(id, { inputTokens: contextTokens(2000, 120), cachedInputTokens: 50, outputTokens: 2 * n });
  const bg = fake.background;
  fake.background = undefined;
  if (bg) startBackground(id, bg);
  turnId = undefined;
  notify("turn/completed", { threadId, turn: { id, status: "completed", items: [] } });
}

/**
 * Background work as Codex 0.167.2 reports it (probed 2026-11-14), started in the turn `turn`: a command item that
 * completes after its turn did; or a sub-agent (subAgentActivity "started"), whose own thread's turn reaches this
 * connection too, then its "completed" activity in the parent's thread. Codex starts no turn by itself after either.
 */
function startBackground(turn: string, bg: { kind: "command" | "agent"; ms: number }): void {
  if (bg.kind === "command") {
    const item = { type: "commandExecution", id: randomUUID(), command: `"powershell.exe" -Command 'Start-Sleep 25'`, status: "inProgress", source: "unifiedExecStartup" };
    notify("item/started", { threadId, turnId: turn, item });
    setTimeout(() => notify("item/completed", { threadId, turnId: turn, item: { ...item, status: "completed", exitCode: 0 } }), bg.ms);
    return;
  }
  const child = randomUUID(), childTurn = randomUUID();
  const activity = (kind: string) => ({ type: "subAgentActivity", id: randomUUID(), kind, agentThreadId: child, agentPath: "/root/fake" });
  const a = activity("started");
  notify("item/started", { threadId, turnId: turn, item: a });
  notify("item/completed", { threadId, turnId: turn, item: a });
  notify("turn/started", { threadId: child, turn: { id: childTurn, status: "inProgress", items: [] } });
  setTimeout(() => {
    notify("item/completed", { threadId: child, turnId: childTurn, item: { type: "agentMessage", id: randomUUID(), text: "sub-agent reply" } });
    notify("turn/completed", { threadId: child, turn: { id: childTurn, status: "completed", items: [] } });
    const c = activity("completed");
    notify("item/started", { threadId, turnId: turn, item: c });
    notify("item/completed", { threadId, turnId: turn, item: c });
  }, bg.ms);
}

/**
 * A failed turn as codex app-server writes it (generate-ts of Codex 0.167.2: ErrorNotification with willRetry,
 * TurnCompletedNotification whose turn has status "failed" and a TurnError with codexErrorInfo; a usage limit comes
 * after account/rateLimits/updated shows a full window).
 */
/**
 * An interrupted turn (turn/interrupt): what was steered in and not taken in is dropped, as Codex 0.167.2 does (probed
 * 2026-11-14); a text the model had begun is written (Codex was not seen doing so; Nexus must not show it either way);
 * the turn completes as "interrupted".
 */
function interrupted(id: string): void {
  steered = [];
  notify("item/completed", { threadId, turnId: id, item: { type: "agentMessage", id: randomUUID(), text: PARTIAL } });
  turnId = undefined;
  notify("turn/completed", { threadId, turn: { id, status: "interrupted", items: [] } });
}

/** Ends the process as a signal would, before turn/completed: the app-server killed, or closing by itself. */
function exitOnSignal(): void { process.kill(process.pid, "SIGTERM"); }

function fail(id: string, kind: FakeFailure): void {
  if (kind === "crash") process.exit(3);
  // cloudflare: no sample from Codex exists; assumed to come as "unauthorized" with the status line and the page's title.
  const info = { overloaded: "serverOverloaded", network: { responseStreamDisconnected: { httpStatusCode: null } }, auth: "unauthorized", limit: "usageLimitExceeded", cloudflare: "unauthorized" }[kind];
  const message = { overloaded: "The server is overloaded", network: "stream disconnected before completion", auth: "401 Unauthorized", limit: "You have hit your usage limit.", cloudflare: "unexpected status 403 Forbidden: Attention Required! | Cloudflare" }[kind];
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
    // Pictures beside the text (localImage items), recorded. A real Codex does not fail on a missing file: the model is
    // told it is missing (probed 2026-11-14), so neither does this one.
    const images = (): string[] => (m.params?.input ?? []).filter((x: { type?: string }) => x.type === "localImage").map((x: { path: string }) => x.path);
    switch (m.method) {
      case "initialize": reply({ userAgent: "fake-codex" }); break;
      case "thread/start": recordArgs({ method: m.method, model: m.params.model, approvalsReviewer: m.params.approvalsReviewer ?? null, approvalPolicy: m.params.approvalPolicy, sandbox: m.params.sandbox, cwd: m.params.cwd, writableRoots: m.params.config?.["sandbox_workspace_write.writable_roots"] ?? null, instructions: m.params.developerInstructions ?? null }); threadId = randomUUID(); reply({ thread: { id: threadId }, model: "fake-codex-model", reasoningEffort: "medium" }); break;
      case "thread/resume": recordArgs({ method: m.method, threadId: m.params.threadId, instructions: m.params.developerInstructions ?? null }); threadId = m.params.threadId; reply({ thread: { id: threadId }, model: "fake-codex-model" }); break;
      case "account/rateLimits/read":
        reply({ rateLimits: { primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 }, secondary: null } });
        break;
      case "turn/start": {
        recordArgs({ method: m.method, effort: m.params.effort ?? null, model: m.params.model ?? null, writableRoots: m.params.sandboxPolicy?.writableRoots ?? null, images: images() });        const t = text();
        record(t, null, !!turnId);
        if (turnId) { fail("a turn is already running"); break; }
        turnId = randomUUID();
        reply({ turn: { id: turnId, status: "inProgress", items: [] } });
        void runTurn(turnId, t);
        break;
      }
      case "turn/steer":
        recordArgs({ method: m.method, images: images() });
        record(text(), "next", !!turnId);
        if (!turnId || m.params.expectedTurnId !== turnId) fail("no active turn");
        else { steered.push(text()); reply({ turnId }); }
        break;
      case "turn/interrupt": record("[interrupt]", null, !!turnId); interrupt(); reply({}); break;
      default: fail(`fake-codex does not implement ${m.method}`);
    }
  }
});
// FAKE_EXIT_DELAY_MS: the process lingers that long after its input closed.
process.stdin.on("end", () => setTimeout(() => process.exit(0), Number(process.env.FAKE_EXIT_DELAY_MS ?? 0)));
