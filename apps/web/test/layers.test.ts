// The history of open layers: Back closes the topmost; a close button does the same; nothing piles up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { close, closeThen, closeTop, isOpen, layerValue, navOf, open, type Nav, type Step } from "../src/layers.ts";

/** A browser history in memory, to play the steps against. */
function browser(start: Nav) {
  const entries: Nav[] = [start];
  let at = 0;
  const cur = () => entries[at]!;
  const apply = (s: Step): void => {
    if (s.op === "push") { entries.splice(at + 1); entries.push(s.to); at++; }
    else if (s.op === "replace") entries[at] = s.to;
    else if (s.op === "seq") s.steps.forEach(apply);
    else if (s.op === "back") { at -= s.steps; assert.ok(at >= 0, "went back past the start"); s.then?.(cur()).forEach(apply); }
  };
  return { cur, apply, back: () => { at--; }, get length() { return entries.length; }, get at() { return at; } };
}
const home: Nav = { hash: "#/p", layers: [], depth: 0 };

test("opening pushes one entry; Back closes the topmost layer and leaves the rest", () => {
  const b = browser(home);
  b.apply(open(b.cur(), "item", "#/p/Q/Q1"));
  b.apply(open(b.cur(), "chat"));
  assert.deepEqual(b.cur(), { hash: "#/p/Q/Q1", layers: ["item", "chat"], depth: 2 });
  b.back();
  assert.deepEqual(b.cur().layers, ["item"], "Back closes the chat, the step stays");
  b.back();
  assert.deepEqual(b.cur(), home, "Back closes the step");
  assert.equal(b.at, 0, "with nothing open, the next Back leaves the app");
});

test("a close button goes back, so Back afterwards does not reopen what was closed", () => {
  const b = browser(home);
  b.apply(open(b.cur(), "chat"));
  b.apply(close(b.cur(), "chat"));
  assert.deepEqual(b.cur(), home);
  assert.equal(b.at, 0);
  b.apply(open(b.cur(), "settings"));
  assert.equal(b.length, 2, "the closed chat's entry was replaced, not kept");
});

test("switching within a kind replaces the entry: another step, another conversation", () => {
  const b = browser(home);
  b.apply(open(b.cur(), "item", "#/p/Q/Q1"));
  b.apply(open(b.cur(), "item", "#/p/Q/Q2"));
  assert.deepEqual(b.cur(), { hash: "#/p/Q/Q2", layers: ["item"], depth: 1 });
  b.apply(open(b.cur(), "ideas"));
  b.apply(open(b.cur(), "conversation:new"));
  assert.equal(layerValue(b.cur(), "conversation"), "new");
  b.apply(open(b.cur(), "conversation:01ABC"));
  assert.equal(layerValue(b.cur(), "conversation"), "01ABC");
  assert.deepEqual(open(b.cur(), "conversation:01ABC"), { op: "none" });
  b.back();
  assert.deepEqual(b.cur().layers, ["item", "ideas"], "Back from a conversation returns to the list");
});

test("closing a panel closes what lies above it", () => {
  const b = browser(home);
  b.apply(open(b.cur(), "ideas"));
  b.apply(open(b.cur(), "conversation:01ABC"));
  assert.deepEqual(close(b.cur(), "ideas"), { op: "back", steps: 2 });
  b.apply(close(b.cur(), "ideas"));
  assert.deepEqual(b.cur(), home);
});

test("Escape closes the topmost layer; for the drawer, its hash goes too", () => {
  const b = browser(home);
  b.apply(open(b.cur(), "item", "#/p/Q"));
  b.apply(open(b.cur(), "waiting"));
  b.apply(closeTop(b.cur(), "#/p"));
  assert.deepEqual(b.cur().layers, ["item"]);
  b.apply(closeTop(b.cur(), "#/p"));
  assert.deepEqual(b.cur(), home);
  assert.deepEqual(closeTop(b.cur(), "#/p"), { op: "none" });
});

test("a page loaded with something open has no entry to go back to: closing rewrites the entry", () => {
  const loaded = navOf(null, "#/p/Q/Q1", "?chat");
  assert.deepEqual(loaded, { hash: "#/p/Q/Q1", layers: ["item", "chat"], depth: 0 });
  const b = browser(loaded);
  b.apply(close(b.cur(), "chat"));
  assert.deepEqual(b.cur(), { hash: "#/p/Q/Q1", layers: ["item"], depth: 0 });
  b.apply(closeTop(b.cur(), "#/p"));
  assert.deepEqual(b.cur(), home);
  assert.equal(b.length, 1);
});

test("an entry's own state is read back; the hash decides whether the drawer is open", () => {
  assert.deepEqual(navOf({ nexus: { hash: "#/p", layers: ["chat"], depth: 1 } }, "#/p", ""), { hash: "#/p", layers: ["chat"], depth: 1 });
  assert.deepEqual(navOf({ nexus: { layers: ["item", "chat"], depth: 2 } }, "#/p", "").layers, ["chat"]);
  assert.deepEqual(navOf({ nexus: { layers: [], depth: 1 } }, "#/p/Q", "").layers, ["item"]);
  assert.deepEqual(navOf({ other: 1 }, "#/p", "").layers, []);
  assert.equal(isOpen(navOf(null, "#/p", "?settings&waiting"), "waiting"), true);
});

test("switching projects from the picker closes it, then changes the page in place", () => {
  const b = browser(home);
  b.apply(open(b.cur(), "projects"));
  b.apply(closeThen(b.cur(), "projects", "#/other"));
  assert.deepEqual(b.cur(), { hash: "#/other", layers: [], depth: 0 });
  assert.equal(b.at, 0, "Back now leaves the app instead of returning to the old project");
});

test("an item from the waiting list opens in its project; Back closes it and stays there", () => {
  const b = browser(home);
  b.apply(open(b.cur(), "waiting"));
  b.apply(closeThen(b.cur(), "waiting", "#/other/N7/N71", "item"));
  assert.deepEqual(b.cur(), { hash: "#/other/N7/N71", layers: ["item"], depth: 1 });
  b.back();
  assert.deepEqual(b.cur(), { hash: "#/other", layers: [], depth: 0 });
  // The same from a waiting list opened with the page (?waiting): nothing to go back to.
  const c = browser(navOf(null, "#/p", "?waiting"));
  c.apply(closeThen(c.cur(), "waiting", "#/other/N7", "item"));
  assert.deepEqual(c.cur(), { hash: "#/other/N7", layers: ["item"], depth: 1 });
  c.back();
  assert.deepEqual(c.cur(), { hash: "#/other", layers: [], depth: 0 });
});

test("wide screen: another step while the chat is open beside it switches the step and keeps the chat", () => {
  const b = browser(home);
  b.apply(open(b.cur(), "chat"));
  b.apply(open(b.cur(), "item", "#/p/Q/Q1"));
  assert.deepEqual(b.cur(), { hash: "#/p/Q/Q1", layers: ["chat", "item"], depth: 2 });
  b.apply(open(b.cur(), "item", "#/p/Q/Q2"));
  assert.deepEqual(b.cur(), { hash: "#/p/Q/Q2", layers: ["chat", "item"], depth: 2 }, "the step on top is switched in place");
  // Chat opened after the step: the step is below it; switching goes back to its entry and opens both again.
  const c = browser(home);
  c.apply(open(c.cur(), "item", "#/p/Q/Q1"));
  c.apply(open(c.cur(), "chat"));
  c.apply(open(c.cur(), "item", "#/p/Q/Q2"));
  assert.deepEqual(c.cur(), { hash: "#/p/Q/Q2", layers: ["item", "chat"], depth: 2 });
  assert.equal(c.length, 3, "no entry piled up");
  c.back();
  assert.deepEqual(c.cur(), { hash: "#/p/Q/Q2", layers: ["item"], depth: 1 }, "Back closes the chat, the new step stays");
  c.back();
  assert.deepEqual(c.cur(), home);
});

test("wide screen: closing the step keeps the chat beside it, and closing the chat keeps the step", () => {
  const b = browser(home);
  b.apply(open(b.cur(), "item", "#/p/Q/Q1"));
  b.apply(open(b.cur(), "chat"));
  b.apply(close(b.cur(), "item"));
  assert.deepEqual(b.cur(), { hash: "#/p", layers: ["chat"], depth: 1 });
  b.back();
  assert.deepEqual(b.cur(), home, "Back then closes the chat: no dead entry of the step");
  const c = browser(home);
  c.apply(open(c.cur(), "chat"));
  c.apply(open(c.cur(), "item", "#/p/Q/Q1"));
  c.apply(close(c.cur(), "chat"));
  assert.deepEqual(c.cur(), { hash: "#/p/Q/Q1", layers: ["item"], depth: 1 });
  c.back();
  assert.deepEqual(c.cur(), home);
});

test("what belongs to a layer closes with it: an image with its step, a conversation with the Ideas panel", () => {
  const b = browser(home);
  b.apply(open(b.cur(), "item", "#/p/Q/Q1"));
  b.apply(open(b.cur(), "viewer:0"));
  b.apply(close(b.cur(), "item"));
  assert.deepEqual(b.cur(), home);
  b.apply(open(b.cur(), "ideas"));
  b.apply(open(b.cur(), "conversation:01ABC"));
  b.apply(open(b.cur(), "item", "#/p/Q/Q1"));
  b.apply(close(b.cur(), "ideas"));
  assert.deepEqual(b.cur(), { hash: "#/p/Q/Q1", layers: ["item"], depth: 1 }, "the step opened beside it stays");
});
