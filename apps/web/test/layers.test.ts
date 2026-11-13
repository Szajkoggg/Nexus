// The history of open layers: Back closes the topmost; a close button does the same; nothing piles up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { close, closeThen, closeTop, isOpen, layerValue, navOf, open, panelOrder, phoneConversation, phoneView, raise, switchProject, switchTab, type Nav, type Step } from "../src/layers.ts";

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

test("the chat and the Ideas panel stack in the order opened; a conversation counts as Ideas", () => {
  assert.deepEqual(panelOrder(home), []);
  const b = browser(home);
  b.apply(open(b.cur(), "chat"));
  b.apply(open(b.cur(), "ideas"));
  b.apply(open(b.cur(), "conversation:01ABC"));
  assert.deepEqual(panelOrder(b.cur()), ["chat", "ideas"], "Ideas, opened last, on top");
  b.back();
  assert.deepEqual(panelOrder(b.cur()), ["chat", "ideas"], "Back to the list: Ideas still on top");
  b.back();
  assert.deepEqual(panelOrder(b.cur()), ["chat"]);

  const c = browser(home);
  c.apply(open(c.cur(), "ideas"));
  c.apply(open(c.cur(), "conversation:01ABC"));
  c.apply(open(c.cur(), "chat"));
  assert.deepEqual(panelOrder(c.cur()), ["ideas", "chat"], "the chat, opened last, on top");
  c.back();
  assert.deepEqual(panelOrder(c.cur()), ["ideas"]);
  // With the step drawer and others in the stack, only the two panels are ordered.
  assert.deepEqual(panelOrder({ hash: "#/p/Q", layers: ["item", "conversation:x", "waiting", "chat"], depth: 4 }), ["ideas", "chat"]);
});

test("the chat switch brings the other panel to the top in one step; Back then shows the one beneath", () => {
  const b = browser(home);
  b.apply(open(b.cur(), "chat"));
  b.apply(raise(b.cur(), "ideas")); // closed: opened on top
  assert.deepEqual(panelOrder(b.cur()), ["chat", "ideas"]);
  b.apply(open(b.cur(), "conversation:01ABC"));
  b.apply(raise(b.cur(), "chat")); // under Ideas: brought up, Ideas and its conversation stay open beneath
  assert.deepEqual(b.cur().layers, ["ideas", "conversation:01ABC", "chat"]);
  assert.deepEqual(panelOrder(b.cur()), ["ideas", "chat"]);
  assert.deepEqual(raise(b.cur(), "chat"), { op: "none" }, "already on top");
  b.apply(raise(b.cur(), "ideas")); // and back: the conversation comes up with its panel
  assert.deepEqual(b.cur().layers, ["chat", "ideas", "conversation:01ABC"]);
  b.back();
  assert.deepEqual(b.cur().layers, ["chat", "ideas"], "Back closes the conversation");
  b.back();
  assert.deepEqual(b.cur().layers, ["chat"], "then the Ideas panel, showing the chat beneath");
  b.back();
  assert.deepEqual(b.cur(), home);
});

test("a header button of a panel open underneath brings it up, with the step drawer staying where it is", () => {
  const b = browser(home);
  b.apply(open(b.cur(), "item", "#/p/Q/Q1"));
  b.apply(open(b.cur(), "ideas"));
  b.apply(open(b.cur(), "chat"));
  b.apply(raise(b.cur(), "ideas"));
  assert.deepEqual(b.cur(), { hash: "#/p/Q/Q1", layers: ["item", "chat", "ideas"], depth: 3 });
  b.back();
  assert.deepEqual(b.cur().layers, ["item", "chat"], "Back shows the chat beneath");

  // Opened at load (?chat&ideas: entries Nexus did not push): the entry is rewritten in the new order.
  const loaded: Nav = { hash: "#/p", layers: ["chat", "ideas"], depth: 0 };
  assert.deepEqual(raise(loaded, "chat"), { op: "replace", to: { hash: "#/p", layers: ["ideas", "chat"], depth: 0 } });
});

// ---------------------------------------------------------------- the phone's tabs

test("phone: switching tabs adds no history entry; Back from any tab leaves the app", () => {
  const b = browser(home);
  assert.equal(phoneView(b.cur()).tab, "waiting", "the Waiting tab shows first");
  for (const t of ["chat", "queues", "ideas", "waiting", "chat"] as const) {
    b.apply(switchTab(b.cur(), t));
    assert.equal(phoneView(b.cur()).tab, t);
  }
  assert.equal(b.length, 1, "no entry was pushed");
  assert.equal(b.at, 0, "Back leaves the app");
  assert.deepEqual(switchTab(b.cur(), "chat"), { op: "none" }, "the tab already shown: nothing to do");
});

test("phone: a sheet opens over the tab, Back closes it and the same tab shows", () => {
  const b = browser(home);
  b.apply(switchTab(b.cur(), "queues"));
  b.apply(open(b.cur(), "item", "#/p/Q/Q1"));
  assert.deepEqual(b.cur(), { hash: "#/p/Q/Q1", layers: ["item"], depth: 1, tab: "queues" }, "the sheet's entry keeps the tab");
  b.apply(open(b.cur(), "viewer:0"));
  b.back();
  assert.deepEqual(phoneView(b.cur()), { tab: "queues", layers: ["item"] }, "Back closes the image, the step stays");
  b.back();
  assert.deepEqual(phoneView(b.cur()), { tab: "queues", layers: [] }, "Back closes the step: the Queues tab again");
  assert.equal(b.at, 0, "and the next Back leaves");
});

test("phone: switching tabs with something open closes it first, without leaving an entry behind", () => {
  const b = browser(home);
  b.apply(switchTab(b.cur(), "ideas"));
  b.apply(open(b.cur(), "conversation:01ABC"));
  assert.deepEqual(phoneView(b.cur()), { tab: "ideas", layers: ["conversation:01ABC"] });
  b.apply(switchTab(b.cur(), "chat"));
  assert.deepEqual(b.cur(), { ...home, tab: "chat" });
  assert.equal(b.at, 0, "the conversation's entry was gone back over");
  b.apply(switchTab(b.cur(), "ideas"));
  b.apply(open(b.cur(), "conversation:01ABC"));
  b.apply(switchTab(b.cur(), "ideas"));
  assert.deepEqual(phoneView(b.cur()), { tab: "ideas", layers: [] }, "tapping the tab shown closes the conversation: the list");
});

test("phone: switching projects shows the Waiting tab and closes what was open; on a desktop the tab is left alone", () => {
  const b = browser(home);
  b.apply(switchTab(b.cur(), "chat"));
  b.apply(switchProject(b.cur(), "#/other", true));
  assert.deepEqual(b.cur(), { hash: "#/other", layers: [], depth: 0, tab: "waiting" });
  b.apply(switchTab(b.cur(), "queues"));
  b.apply(open(b.cur(), "item", "#/other/Q/Q1"));
  b.apply(open(b.cur(), "projects"));
  b.apply(switchProject(b.cur(), "#/p", true));
  assert.deepEqual(b.cur(), { hash: "#/p", layers: [], depth: 0, tab: "waiting" }, "the sheet and the picker closed, Back leaves");
  const d = browser(home);
  d.apply(switchProject(d.cur(), "#/other", false));
  assert.deepEqual(d.cur(), { ...home, hash: "#/other" });
});

test("phone: the chat, Ideas and the waiting list show as tabs, not layers; a conversation over the Ideas tab", () => {
  assert.deepEqual(phoneView({ ...home, layers: ["chat"] }), { tab: "chat", layers: [] }, "?chat at load");
  assert.deepEqual(phoneView({ ...home, layers: ["item", "chat", "ideas"] }), { tab: "ideas", layers: ["item"] }, "the topmost wins");
  assert.deepEqual(phoneView({ ...home, tab: "queues", layers: ["ideas", "conversation:x"] }), { tab: "ideas", layers: ["conversation:x"] });
  assert.deepEqual(phoneView({ ...home, tab: "queues", layers: ["item"] }), { tab: "queues", layers: ["item"] });
  assert.deepEqual(navOf({ nexus: { layers: [], depth: 2, tab: "ideas" } }, "#/p", ""), { hash: "#/p", layers: [], depth: 2, tab: "ideas" }, "the tab is read back from the entry");
  assert.deepEqual(navOf({ nexus: { layers: [], depth: 0, tab: "bogus" } }, "#/p", ""), home, "an unknown tab is dropped");
});

test("phone: Chat about this on a step's sheet closes the sheet, shows Ideas and opens the conversation over it; Back returns to the list", () => {
  const b = browser(home);
  b.apply(switchTab(b.cur(), "queues"));
  b.apply(open(b.cur(), "item", "#/p/Q/Q1"));
  b.apply(phoneConversation(b.cur(), "01ABC"));
  assert.deepEqual(phoneView(b.cur()), { tab: "ideas", layers: ["conversation:01ABC"] });
  assert.equal(b.cur().hash, "#/p", "the step's sheet closed");
  b.back();
  assert.deepEqual(phoneView(b.cur()), { tab: "ideas", layers: [] });
  assert.equal(b.at, 0);
  b.apply(phoneConversation(b.cur(), "01ABC"));
  b.apply(phoneConversation(b.cur(), "01DEF"));
  assert.deepEqual(b.cur().layers, ["conversation:01DEF"], "from one conversation to another: switched in place");
  assert.equal(b.at, 1);
});
