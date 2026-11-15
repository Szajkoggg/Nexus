import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_NOTIFY, type NotifySettings } from "@nexus/protocol/notify";
import { tabNews, type TabItem } from "../src/notify.ts";

const item = (key: string, kind: TabItem<string>["kind"]): TabItem<string> => ({ key, kind, item: key });
const quiet: NotifySettings = { ...DEFAULT_NOTIFY, quiet: { on: true, from: "22:00", to: "07:00" }, timezone: "Europe/Budapest" };
const night = new Date("2026-11-15T22:30:00Z"); // 23:30 in Budapest
const day = new Date("2026-11-15T10:00:00Z");

test("the tab's first look is the baseline; afterwards only what is new", () => {
  const now = [item("p:a", "question"), item("p:b", "review")];
  assert.deepEqual(tabNews(null, now, DEFAULT_NOTIFY, day), []);
  assert.deepEqual(tabNews(new Set(["p:a"]), now, DEFAULT_NOTIFY, day).map((x) => x.key), ["p:b"]);
});

test("the in-tab fallback filters as a push device does: kinds turned off, quiet hours, urgent breaking through", () => {
  const seen = new Set<string>();
  const now = [item("p:q", "question"), item("p:s", "stopped"), item("p:r", "review")];
  assert.deepEqual(tabNews(seen, now, { ...DEFAULT_NOTIFY, off: ["review"] }, day).map((x) => x.key), ["p:q", "p:s"]);
  assert.deepEqual(tabNews(seen, now, quiet, night), [], "quiet hours in the browser's zone");
  assert.deepEqual(tabNews(seen, now, quiet, day).map((x) => x.key), ["p:q", "p:s", "p:r"]);
  assert.deepEqual(tabNews(seen, now, { ...quiet, urgent: true }, night).map((x) => x.key), ["p:s"]);
});
