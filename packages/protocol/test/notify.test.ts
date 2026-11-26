import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_NOTIFY, NOTIFY_KINDS, inQuietHours, minuteOfDay, notifySettingsOf, parseNotifySettings, shouldNotify, type NotifySettings } from "../src/notify.ts";
import type { AttentionItem } from "../src/state.ts";

const settings = (s: Partial<Omit<NotifySettings, "quiet">> & { quiet?: Partial<NotifySettings["quiet"]> } = {}): NotifySettings =>
  ({ ...DEFAULT_NOTIFY, ...s, quiet: { ...DEFAULT_NOTIFY.quiet, ...s.quiet } });
/** 2026-11-15 at a UTC time. */
const utc = (clock: string) => new Date(`2026-11-15T${clock}:00Z`);

test("by default every kind goes, at any time", () => {
  for (const k of NOTIFY_KINDS) {
    assert.equal(shouldNotify(k, utc("03:00"), DEFAULT_NOTIFY), true, k);
  }
});

test("a kind turned off does not go; the others do", () => {
  const s = settings({ off: ["review", "tags"] });
  assert.equal(shouldNotify("review", utc("12:00"), s), false);
  assert.equal(shouldNotify("tags", utc("12:00"), s), false);
  assert.equal(shouldNotify("question", utc("12:00"), s), true);
});

test("quiet hours over midnight (22:00-07:00) hold back everything inside them", () => {
  const s = settings({ quiet: { on: true, from: "22:00", to: "07:00" }, timezone: "UTC" });
  assert.equal(shouldNotify("question", utc("21:59"), s), true);
  assert.equal(shouldNotify("question", utc("22:00"), s), false);
  assert.equal(shouldNotify("question", utc("23:30"), s), false);
  assert.equal(shouldNotify("question", utc("00:00"), s), false);
  assert.equal(shouldNotify("question", utc("06:59"), s), false);
  assert.equal(shouldNotify("question", utc("07:00"), s), true);
  assert.equal(shouldNotify("question", utc("03:00"), settings({ quiet: { on: false }, timezone: "UTC" })), true, "quiet hours off");
  assert.equal(inQuietHours(13 * 60, "12:00", "14:00"), true, "within a day");
  assert.equal(inQuietHours(15 * 60, "12:00", "14:00"), false);
  assert.equal(inQuietHours(15 * 60, "08:00", "08:00"), false, "from equal to to: no quiet hours");
});

test("quiet hours are in the device's time zone, not the server's", () => {
  // 21:30 UTC is 22:30 in Budapest (CET, UTC+1 in November) and 16:30 in New York.
  const at = utc("21:30");
  const quiet = { on: true, from: "22:00", to: "07:00" };
  assert.equal(minuteOfDay(at, "Europe/Budapest"), 22 * 60 + 30);
  assert.equal(shouldNotify("question", at, settings({ quiet, timezone: "Europe/Budapest" })), false);
  assert.equal(shouldNotify("question", at, settings({ quiet, timezone: "America/New_York" })), true);
  assert.equal(shouldNotify("question", at, settings({ quiet, timezone: "UTC" })), true);
});

test("urgent breaks through: stopped, failed and a failed update come through the quiet hours, nothing else", () => {
  const quiet = { on: true, from: "22:00", to: "07:00" };
  const night = utc("02:00");
  const through = settings({ quiet, urgent: true, timezone: "UTC" });
  const held = settings({ quiet, urgent: false, timezone: "UTC" });
  for (const k of ["stopped", "failed", "update_failed"] as const) {
    assert.equal(shouldNotify(k, night, through), true, k);
    assert.equal(shouldNotify(k, night, held), false, `${k} without urgent`);
  }
  for (const k of NOTIFY_KINDS.filter((x) => !["stopped", "failed", "update_failed"].includes(x))) {
    assert.equal(shouldNotify(k, night, through), false, k);
  }
  assert.equal(shouldNotify("stopped", night, settings({ quiet, urgent: true, off: ["stopped"], timezone: "UTC" })), false, "a kind turned off stays off");
});

test("the test notification always goes", () => {
  const all = settings({ off: [...NOTIFY_KINDS], quiet: { on: true, from: "00:00", to: "23:59" }, timezone: "UTC" });
  assert.equal(shouldNotify("test", utc("12:00"), all), true);
});

test("a subscription from before the settings gets the defaults; bad stored values do not silence a device", () => {
  assert.deepEqual(notifySettingsOf(undefined), DEFAULT_NOTIFY);
  assert.deepEqual(notifySettingsOf({ off: "everything" }), DEFAULT_NOTIFY);
  assert.deepEqual(notifySettingsOf({ off: ["review", "someday-kind"], quiet: { on: true } }),
    { off: ["review"], quiet: { on: true, from: "22:00", to: "07:00" }, urgent: false });
});

test("what a device sends is checked, with every problem named", () => {
  const bad = parseNotifySettings({ off: 3, quiet: { on: "yes", from: "25:00", to: "7" }, urgent: 1, timezone: "Mars/Olympus" });
  assert.ok("error" in bad);
  for (const part of ["off:", "quiet.on", "quiet.from", "quiet.to", "urgent", "timezone"]) assert.match(bad.error, new RegExp(part.replace(".", "\\.")));
  assert.deepEqual(parseNotifySettings({ quiet: { on: true, from: "23:00", to: "06:30" }, urgent: true, timezone: "Europe/Budapest" }),
    { settings: { off: [], quiet: { on: true, from: "23:00", to: "06:30" }, urgent: true, timezone: "Europe/Budapest" } });
});

test("every kind of the waiting list is a notification kind", () => {
  const kinds: Record<AttentionItem["kind"], true> = {
    question: true, stopped: true, approval: true, review: true, failed: true, start: true, provisional: true,
    plan: true, merge: true, tags: true, recurring: true, cleanup: true, links: true, paused: true,
  };
  for (const k of Object.keys(kinds)) assert.ok((NOTIFY_KINDS as readonly string[]).includes(k), k);
});
