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

test("Claude Code: a Cloudflare 403 page is passing; a credential failure stays lasting", () => {
  // The shape queue N7 met on 2026-11-13: the assistant's error, the result's status and text.
  const n7 = classifyClaudeResult(result({ api_error_status: 403, result: "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare" }), { apiError: "authentication_failed" })!;
  assert.deepEqual([n7.kind, n7.code, n7.text], ["passing", "edge_block_403", "Failed to authenticate. API Error: 403 Attention Required! | Cloudflare"]);
  // A long page: the mark is found beyond the 300 characters the text keeps.
  const page = classifyClaudeResult(result({ api_error_status: 403, result: `API Error: 403 <html>${"x".repeat(400)}<title>Just a moment...</title> cf-ray: 8a1b</html>` }), { apiError: "authentication_failed" })!;
  assert.equal(`${page.kind} ${page.code}`, "passing edge_block_403");
  const lasting = (text: string, status?: number) => { const f = classifyClaudeResult(result({ api_error_status: status, result: text }), { apiError: "authentication_failed" })!; return `${f.kind} ${f.code}`; };
  assert.equal(lasting("Invalid API key - Please run /login", 401), "lasting authentication_failed");
  assert.equal(lasting("Failed to authenticate. API Error: 401 OAuth token has expired"), "lasting authentication_failed");
  assert.equal(lasting("API Error: 403 Forbidden: your organization has disabled this model", 403), "lasting authentication_failed", "a 403 without an edge's mark");
  assert.equal(lasting("Failed to authenticate: see the Cloudflare status page", 401), "lasting authentication_failed", "an edge's name without a 403");
});

test("Codex: a Cloudflare 403 page is passing whatever its code; unauthorized stays lasting", () => {
  // No sample from Codex: assumed to come as "unauthorized" (or "other") with the status line and the page's title.
  const f = (info: unknown, message: string) => { const x = classifyCodexError({ message, codexErrorInfo: info, additionalDetails: null }); return `${x.kind} ${x.code}`; };
  assert.equal(f("unauthorized", "unexpected status 403 Forbidden: Attention Required! | Cloudflare"), "passing edge_block_403");
  assert.equal(f("other", "unexpected status 403 Forbidden: <title>Just a moment...</title>"), "passing edge_block_403");
  assert.equal(f({ responseStreamConnectionFailed: { httpStatusCode: 403 } }, "403 Attention Required! | Cloudflare"), "passing responseStreamConnectionFailed", "as a connection failure it is passing by its code");
  assert.equal(f("unauthorized", "401 Unauthorized"), "lasting unauthorized");
  assert.equal(f("unauthorized", "unexpected status 403 Forbidden: missing scope api.responses.write"), "lasting unauthorized");
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
