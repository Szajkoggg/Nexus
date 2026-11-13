// Each chat's place and what is unread in it: where a chat opens, what counts as new, what was seen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { firstUnread, hasUnread, opening, parsePlace, placeKey, seenUpTo, unreadCount } from "../src/chatPlace.ts";

const T = (m: number) => new Date(Date.UTC(2026, 10, 14, 10, m)).toISOString();
const chat = [
  { at: T(0), from: "user", kind: "message" },
  { at: T(1), from: "orchestrator", kind: "tool" },
  { at: T(2), from: "orchestrator", kind: "message" },
  { at: T(5), from: "nexus", kind: "message" },
  { at: T(6), from: "user", kind: "message" },
  { at: T(7), from: "orchestrator", kind: "tool" },
  { at: T(8), from: "orchestrator", kind: "message" },
];

test("a chat opens at its end the first time, else at its place, whatever came after", () => {
  assert.deepEqual(opening(undefined, 7), { at: "end" });
  assert.deepEqual(opening({ anchor: 2, offset: -30, end: false }, 7), { at: "place", anchor: 2, offset: -30 });
  assert.deepEqual(opening({ anchor: 6, offset: 0, end: true }, 9), { at: "place", anchor: 6, offset: 0 }, "it was at the end: new messages below, the view stays");
  assert.deepEqual(opening({ anchor: 6, offset: 0, end: true }, 3), { at: "end" }, "the chat started over: shorter than the place");
});

test("unread: messages of others after the time seen, not the user's own, not tool lines; none for a chat never seen", () => {
  assert.equal(unreadCount(chat, T(2)), 2, "Nexus's notice and the orchestrator's reply");
  assert.equal(unreadCount(chat, T(8)), 0);
  assert.equal(unreadCount(chat, undefined), 0);
  assert.equal(firstUnread(chat, T(2)), 3);
  assert.equal(firstUnread(chat, T(6)), 6, "the tool line before it does not count");
  assert.equal(firstUnread(chat, T(8)), undefined);
  assert.equal(hasUnread(T(9), T(8)), true);
  assert.equal(hasUnread(T(8), T(8)), false);
  assert.equal(hasUnread(T(9), undefined), false, "a conversation not seen in this session has no marker");
});

test("what was seen: the latest entry in view so far, never going back", () => {
  assert.equal(seenUpTo(chat, 2, undefined), T(2));
  assert.equal(seenUpTo(chat, 1, T(5)), T(5), "scrolling up does not unsee");
  assert.equal(seenUpTo(chat, 99, T(2)), T(8));
  assert.equal(seenUpTo([], 0, undefined), undefined);
});

test("keys and stored places", () => {
  assert.equal(placeKey("my project", "conversation", "01AB"), "my%20project/conversation/01AB");
  assert.deepEqual(parsePlace(JSON.stringify({ anchor: 3, offset: -12.5, end: false, seen: T(2) })), { anchor: 3, offset: -12.5, end: false, seen: T(2) });
  assert.deepEqual(parsePlace(JSON.stringify({ anchor: 3, offset: 0, end: true })), { anchor: 3, offset: 0, end: true });
  assert.equal(parsePlace("{bad"), undefined);
  assert.equal(parsePlace(JSON.stringify({ anchor: "3" })), undefined);
  assert.equal(parsePlace(null), undefined);
});
