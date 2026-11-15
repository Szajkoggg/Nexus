// The fallback chain's line in the settings panel: written and read back; an entry it cannot read is named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fallbackLine, parseFallback } from "../src/fallback.ts";

test("a chain as a line and back; a bad entry is named", () => {
  const chain = [{ runtime: "codex" as const, model: "gpt-6-luna", effort: "low" as const }, { runtime: "codex" as const, effort: "high" as const }, "wait" as const];
  assert.equal(fallbackLine(chain), "codex gpt-6-luna low, codex high, wait");
  assert.deepEqual(parseFallback(fallbackLine(chain)), { chain });
  assert.deepEqual(parseFallback("  "), { chain: [] }, "empty: none");
  assert.equal(fallbackLine(undefined), "");
  assert.deepEqual(parseFallback("codex, gemini pro"), { bad: "gemini pro" });
  assert.deepEqual(parseFallback("claude haiku sonnet"), { bad: "claude haiku sonnet" });
});
