// The dashboard's translation layer: parameters, plural forms, the fallback to English, and dates, times and durations
// through Intl, which in English read as the dashboard's texts did before the layer.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { addLanguage, formatClock, formatDuration, language, rich, setLanguage, t, timeAgo } from "../src/i18n.ts";
import { en } from "../src/messages/en.ts";
import { formatClock as clockBefore, formatDuration as durationBefore } from "@nexus/protocol/times";

afterEach(() => { setLanguage("en"); });

// A made-up translation for the tests: Polish plural rules (one, few, many), some keys only.
addLanguage({
  code: "xx", locale: "pl",
  messages: {
    "rail.nothingRuns": "Nic nie działa.",
    "rail.runningIn": "Działa w {project}",
    "digest.kind.question": { one: "{count} pytanie", few: "{count} pytania", many: "{count} pytań", other: "{count} pytania" },
  },
});

test("a text in English, the source", () => {
  assert.equal(language().code, "en");
  assert.equal(t("rail.nothingRuns"), "Nothing runs.");
});

test("parameters fill their placeholders; numbers are formatted for the locale", () => {
  assert.equal(t("rail.runningIn", { project: "Nexus" }), "Running in Nexus");
  assert.equal(t("shell.placeInWaiting", { at: 2, total: 6 }), "2 of 6 waiting");
  assert.equal(t("rail.finishedToday", { count: 1234 }), "Finished today · 1,234");
});

test("a placeholder without a value stays as written", () => {
  assert.equal(t("rail.runningIn"), "Running in {project}");
  assert.equal(t("shell.placeInWaiting", { at: 2 }), "2 of {total} waiting");
});

test("a plural message chooses its form by count", () => {
  assert.equal(t("digest.kind.question", { count: 1 }), "1 question");
  assert.equal(t("digest.kind.question", { count: 0 }), "0 questions");
  assert.equal(t("digest.kind.question", { count: 5 }), "5 questions");
  assert.equal(t("shell.warnings", { count: 1 }), "1 warning reading the project files");
  assert.equal(t("shell.warnings", { count: 3 }), "3 warnings reading the project files");
  // A form-only message with no {count} in it.
  assert.equal(t("digest.tile.finished", { count: 1 }), "step finished");
  assert.equal(t("digest.tile.finished", { count: 2 }), "steps finished");
  // Without a count, the other form.
  assert.equal(t("digest.tile.finished"), "steps finished");
});

test("plural forms follow the language's rules", () => {
  setLanguage("xx");
  assert.equal(t("digest.kind.question", { count: 1 }), "1 pytanie");
  assert.equal(t("digest.kind.question", { count: 3 }), "3 pytania");
  assert.equal(t("digest.kind.question", { count: 5 }), "5 pytań");
  assert.equal(t("digest.kind.question", { count: 22 }), "22 pytania");
});

test("a key a translation lacks falls back to English", () => {
  setLanguage("xx");
  assert.equal(t("rail.nothingRuns"), "Nic nie działa.");
  assert.equal(t("rail.runningIn", { project: "Nexus" }), "Działa w Nexus");
  assert.equal(t("rail.allProjects"), "all projects");
  // English plural rules for an English fallback.
  assert.equal(t("shell.warnings", { count: 1 }), "1 warning reading the project files");
});

test("an unknown language keeps English", () => {
  assert.equal(setLanguage("zz").code, "en");
  assert.equal(t("rail.nothingRuns"), "Nothing runs.");
});

test("rich text keeps element parameters as parts", () => {
  const code = { element: "code" };
  assert.deepEqual(rich("shell.noProjects", { command: code }), ["No projects yet. Register one with ", code, "."]);
});

test("every English message is a string or has an other form", () => {
  for (const [key, m] of Object.entries(en)) {
    assert.ok(typeof m === "string" || typeof (m as { other?: unknown }).other === "string", key);
  }
});

test("times read in English as they did before: 14:02, 11 Nov 14:02, 11 Nov 2025 14:02", () => {
  const now = new Date(2026, 10, 14, 15, 30);
  const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).toISOString();
  assert.equal(formatClock(at(2026, 10, 14, 14, 2), now), "14:02");
  assert.equal(formatClock(at(2026, 10, 14, 9, 5), now), "09:05");
  assert.equal(formatClock(at(2026, 10, 11, 14, 2), now), "11 Nov 14:02");
  assert.equal(formatClock(at(2025, 10, 11, 0, 0), now), "11 Nov 2025 00:00");
  for (const iso of [at(2026, 10, 14, 23, 59), at(2026, 0, 1, 7, 0), at(2024, 1, 29, 12, 30)]) {
    assert.equal(formatClock(iso, now), clockBefore(iso, now), iso);
  }
});

test("durations read in English as they did before", () => {
  for (const min of [0, 0.5, 1, 12, 59, 60, 72, 180, 1439, 1440, 1500, 3180, 10_000]) {
    assert.equal(formatDuration(min * 60_000), durationBefore(min * 60_000), `${min} min`);
  }
  assert.equal(formatDuration(72 * 60_000), "1 h 12 min");
});

test("how long ago", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  const ago = (s: number) => timeAgo(new Date(now - s * 1000).toISOString(), now);
  assert.equal(ago(10), "just now");
  assert.equal(ago(300), "5 min ago");
  assert.equal(ago(3 * 3600), "3 h ago");
  assert.equal(ago(2 * 86400 + 5), "2 d ago");
});
