// The history of open layers: Back closes the topmost; a close button does the same; nothing piles up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { close, closeThen, closeTop, isOpen, layerValue, navOf, open, openConversation, phoneView, switchProject, switchTab, viewOf, type Nav, type Step } from "../src/layers.ts";

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
  b.apply(open(b.cur(), "viewer:0"));
  assert.deepEqual(b.cur(), { hash: "#/p/Q/Q1", layers: ["item", "viewer:0"], depth: 2 });
  b.back();
  assert.deepEqual(b.cur().layers, ["item"], "Back closes the image, the step stays");
  b.back();
  assert.deepEqual(b.cur(), home, "Back closes the step");
  assert.equal(b.at, 0, "with nothing open, the next Back leaves the app");
});

test("a close button goes back, so Back afterwards does not reopen what was closed", () => {
  const b = browser(home);
  b.apply(open(b.cur(), "settings"));
  b.apply(close(b.cur(), "settings"));
  assert.deepEqual(b.cur(), home);
  assert.equal(b.at, 0);
  b.apply(open(b.cur(), "remote"));
  assert.equal(b.length, 2, "the closed settings' entry was replaced, not kept");
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

test("another step while a conversation lies over it switches the step and keeps the conversation", () => {
  const b = browser(home);
  b.apply(open(b.cur(), "conversation:01ABC"));
  b.apply(open(b.cur(), "item", "#/p/Q/Q1"));
  assert.deepEqual(b.cur(), { hash: "#/p/Q/Q1", layers: ["conversation:01ABC", "item"], depth: 2 });
  b.apply(open(b.cur(), "item", "#/p/Q/Q2"));
  assert.deepEqual(b.cur(), { hash: "#/p/Q/Q2", layers: ["conversation:01ABC", "item"], depth: 2 }, "the step on top is switched in place");
  // The conversation opened after the step: the step is below it; switching goes back to its entry and opens both again.
  const c = browser(home);
  c.apply(open(c.cur(), "item", "#/p/Q/Q1"));
  c.apply(open(c.cur(), "conversation:01ABC"));
  c.apply(open(c.cur(), "item", "#/p/Q/Q2"));
  assert.deepEqual(c.cur(), { hash: "#/p/Q/Q2", layers: ["item", "conversation:01ABC"], depth: 2 });
  assert.equal(c.length, 3, "no entry piled up");
  c.back();
  assert.deepEqual(c.cur(), { hash: "#/p/Q/Q2", layers: ["item"], depth: 1 }, "Back closes the conversation, the new step stays");
  c.back();
  assert.deepEqual(c.cur(), home);
});

test("closing the step keeps the conversation beside it, and closing the conversation keeps the step", () => {
  const b = browser(home);
  b.apply(open(b.cur(), "item", "#/p/Q/Q1"));
  b.apply(open(b.cur(), "conversation:01ABC"));
  b.apply(close(b.cur(), "item"));
  assert.deepEqual(b.cur(), { hash: "#/p", layers: ["conversation:01ABC"], depth: 1 });
  b.back();
  assert.deepEqual(b.cur(), home, "Back then closes the conversation: no dead entry of the step");
  const c = browser(home);
  c.apply(open(c.cur(), "conversation:01ABC"));
  c.apply(open(c.cur(), "item", "#/p/Q/Q1"));
  c.apply(close(c.cur(), "conversation"));
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
  // An Ideas layer only comes from a link (?ideas); a conversation over it closes with it.
  const c = browser(navOf(null, "#/p", "?ideas"));
  c.apply(open(c.cur(), "conversation:01ABC"));
  c.apply(open(c.cur(), "item", "#/p/Q/Q1"));
  c.apply(close(c.cur(), "ideas"));
  assert.deepEqual(c.cur().layers, ["item"], "the step opened beside it stays");
});

// ---------------------------------------------------------------- a desktop's middle column

test("desktop: the chat shows first; switching to Ideas or the queues adds no history entry, and Back leaves the app", () => {
  const b = browser(home);
  assert.equal(viewOf(b.cur(), "desk").tab, "chat", "the orchestrator chat shows first");
  for (const t of ["ideas", "queues", "chat", "queues"] as const) {
    b.apply(switchTab(b.cur(), t, "desk"));
    assert.equal(viewOf(b.cur(), "desk").tab, t);
  }
  assert.equal(b.length, 1, "no entry was pushed");
  assert.equal(b.at, 0, "Back leaves the app");
  assert.deepEqual(switchTab(b.cur(), "queues", "desk"), { op: "none" }, "the view already shown: nothing to do");
  assert.equal(viewOf({ ...home, tab: "waiting" }, "desk").tab, "chat", "the phone's Waiting tab, made wide, shows the chat");
});

test("desktop: a step open beside the middle stays open when the view switches; Back then closes it and keeps the view", () => {
  const b = browser(home);
  b.apply(open(b.cur(), "item", "#/p/Q/Q1"));
  b.apply(open(b.cur(), "viewer:0"));
  b.apply(switchTab(b.cur(), "ideas", "desk"));
  assert.deepEqual(b.cur(), { hash: "#/p/Q/Q1", layers: ["item", "viewer:0"], depth: 2, tab: "ideas" });
  assert.equal(b.length, 3, "no entry piled up");
  b.back();
  b.back();
  assert.deepEqual(b.cur(), { ...home, tab: "ideas" }, "Back closed the image and the step; Ideas still shows");
  assert.equal(b.at, 0);
  // Opened at load (a hash with a step): there is no entry below to rewrite, so the entry itself is.
  const c = browser(navOf(null, "#/p/Q/Q1", ""));
  c.apply(switchTab(c.cur(), "queues", "desk"));
  assert.deepEqual(c.cur(), { hash: "#/p/Q/Q1", layers: ["item"], depth: 0, tab: "queues" });
});

test("desktop: a conversation belongs to the Ideas view: another view closes it, the Ideas switch shows the list again", () => {
  const b = browser(home);
  b.apply(switchTab(b.cur(), "ideas", "desk"));
  b.apply(open(b.cur(), "item", "#/p/Q/Q1"));
  b.apply(open(b.cur(), "conversation:01ABC"));
  b.apply(switchTab(b.cur(), "ideas", "desk"));
  assert.deepEqual(b.cur(), { hash: "#/p/Q/Q1", layers: ["item"], depth: 1, tab: "ideas" }, "the list, the step still beside it");
  b.apply(open(b.cur(), "conversation:01ABC"));
  b.apply(switchTab(b.cur(), "chat", "desk"));
  assert.deepEqual(b.cur(), { hash: "#/p/Q/Q1", layers: ["item"], depth: 1, tab: "chat" });
});

test("desktop: the chat and Ideas from a link or older code are views; the waiting list stays a drawer", () => {
  assert.deepEqual(viewOf(navOf(null, "#/p", "?ideas"), "desk"), { tab: "ideas", layers: [] });
  assert.deepEqual(viewOf({ ...home, tab: "queues", layers: ["item", "chat"] }, "desk"), { tab: "chat", layers: ["item"] });
  assert.deepEqual(viewOf({ ...home, layers: ["waiting"] }, "desk"), { tab: "chat", layers: ["waiting"] });
  const b = browser(navOf(null, "#/p", "?chat"));
  b.apply(switchTab(b.cur(), "queues", "desk"));
  assert.deepEqual(b.cur(), { ...home, tab: "queues" }, "the chat layer is dropped as the view switches");
});

test("desktop: switching projects closes what was open and shows the project's orchestrator chat", () => {
  const b = browser(home);
  b.apply(switchTab(b.cur(), "queues", "desk"));
  b.apply(open(b.cur(), "item", "#/p/Q/Q1"));
  b.apply(switchProject(b.cur(), "#/other", "desk"));
  assert.deepEqual(b.cur(), { hash: "#/other", layers: [], depth: 0, tab: "chat" });
  assert.equal(b.at, 0, "Back leaves the app instead of returning to the old project");
});

test("desktop: Chat about this on a step keeps the step beside, shows Ideas and opens the conversation; Back closes them in turn", () => {
  const b = browser(home);
  b.apply(open(b.cur(), "item", "#/p/Q/Q1"));
  b.apply(openConversation(b.cur(), "01ABC", "desk"));
  assert.deepEqual(b.cur(), { hash: "#/p/Q/Q1", layers: ["item", "conversation:01ABC"], depth: 2, tab: "ideas" });
  b.apply(openConversation(b.cur(), "01DEF", "desk"));
  assert.deepEqual(b.cur().layers, ["item", "conversation:01DEF"], "another conversation: switched in place");
  b.back();
  assert.deepEqual(b.cur(), { hash: "#/p/Q/Q1", layers: ["item"], depth: 1, tab: "ideas" }, "Back returns to the list");
  b.back();
  assert.deepEqual(b.cur(), { ...home, tab: "ideas" });
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

test("phone: switching projects shows the Waiting tab and closes what was open", () => {
  const b = browser(home);
  b.apply(switchTab(b.cur(), "chat"));
  b.apply(switchProject(b.cur(), "#/other", "phone"));
  assert.deepEqual(b.cur(), { hash: "#/other", layers: [], depth: 0, tab: "waiting" });
  b.apply(switchTab(b.cur(), "queues"));
  b.apply(open(b.cur(), "item", "#/other/Q/Q1"));
  b.apply(open(b.cur(), "projects"));
  b.apply(switchProject(b.cur(), "#/p", "phone"));
  assert.deepEqual(b.cur(), { hash: "#/p", layers: [], depth: 0, tab: "waiting" }, "the sheet and the picker closed, Back leaves");
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
  b.apply(openConversation(b.cur(), "01ABC"));
  assert.deepEqual(phoneView(b.cur()), { tab: "ideas", layers: ["conversation:01ABC"] });
  assert.equal(b.cur().hash, "#/p", "the step's sheet closed");
  b.back();
  assert.deepEqual(phoneView(b.cur()), { tab: "ideas", layers: [] });
  assert.equal(b.at, 0);
  b.apply(openConversation(b.cur(), "01ABC"));
  b.apply(openConversation(b.cur(), "01DEF"));
  assert.deepEqual(b.cur().layers, ["conversation:01DEF"], "from one conversation to another: switched in place");
  assert.equal(b.at, 1);
});
