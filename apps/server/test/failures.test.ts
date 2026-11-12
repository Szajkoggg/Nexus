// How the adapters tell a failed turn's reason from the runtimes' codes (src/claude.ts, src/codex.ts). The shapes are
// the Agent SDK's sdk.d.ts (Claude Code) and `codex app-server generate-ts` (Codex); see DESIGN.md, "Failures".
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyClaudeResult } from "../src/claude.ts";
import { classifyCodexError } from "../src/codex.ts";

const result = (extra: Record<string, unknown>) => ({ type: "result", subtype: "success", is_error: true, result: "API Error", ...extra });
const soon = () => new Date(Date.now() + 3_600_000).toISOString();

test("Claude Code: success, interruption and refusal", () => {
  assert.equal(classifyClaudeResult({ type: "result", subtype: "success", is_error: false, result: "ok" }, {}), undefined);
  assert.equal(classifyClaudeResult(result({ subtype: "error_during_execution", terminal_reason: "aborted_streaming" }), {}), undefined, "interrupted");
  assert.equal(classifyClaudeResult({ type: "result", subtype: "success", is_error: false, stop_reason: "refusal", result: "" }, {})?.kind, "lasting");
  assert.equal(classifyClaudeResult(result({}), { refusal: true })?.code, "refusal");
});

test("Claude Code: the assistant's error, else the HTTP status, else the subtype", () => {
  const kind = (extra: Record<string, unknown>, signs = {}) => { const f = classifyClaudeResult(result(extra), signs)!; return `${f.kind} ${f.code}`; };
  assert.equal(kind({}, { apiError: "overloaded" }), "passing overloaded");
  assert.equal(kind({ api_error_status: 529 }), "passing overloaded");
  assert.equal(kind({ api_error_status: 503 }), "passing server_error");
  assert.equal(kind({ api_error_status: 429 }), "passing rate_limit", "a rate limit without a reset time is waited out");
  assert.equal(kind({}, { apiError: "rate_limit", resetsAt: soon() }), "usage rate_limit");
  assert.equal(kind({}, { apiError: "unknown", connectionRetry: true }), "passing connection", "retries without an HTTP status: the network");
  assert.equal(kind({}, { apiError: "authentication_failed" }), "lasting authentication_failed");
  assert.equal(kind({ api_error_status: 401 }), "lasting authentication_failed");
  assert.equal(kind({ api_error_status: 400 }), "lasting invalid_request");
  assert.equal(kind({}, { apiError: "billing_error" }), "lasting billing_error");
  assert.equal(kind({ subtype: "error_max_turns" }), "lasting error_max_turns");
  assert.equal(kind({}), "lasting unknown");
});

test("Codex: the TurnError's codexErrorInfo, a string or a one-key object", () => {
  const kind = (info: unknown, resetsAt?: string) => { const f = classifyCodexError({ message: "m", codexErrorInfo: info, additionalDetails: null }, resetsAt); return `${f.kind} ${f.code}`; };
  assert.equal(kind("serverOverloaded"), "passing serverOverloaded");
  assert.equal(kind("rateLimitExceeded"), "passing rateLimitExceeded");
  assert.equal(kind({ responseStreamDisconnected: { httpStatusCode: null } }), "passing responseStreamDisconnected");
  assert.equal(kind({ httpConnectionFailed: { httpStatusCode: 502 } }), "passing httpConnectionFailed");
  assert.equal(kind("usageLimitExceeded", soon()), "usage usageLimitExceeded");
  assert.equal(kind("usageLimitExceeded"), "passing usageLimitExceeded", "no known reset: waited out like a short rate limit");
  assert.equal(kind("unauthorized"), "lasting unauthorized");
  assert.equal(kind("badRequest"), "lasting badRequest");
  assert.equal(kind("cyberPolicy"), "lasting cyberPolicy");
  assert.equal(kind(null), "lasting unknown");
  assert.equal(classifyCodexError(undefined).code, "unknown");
});
