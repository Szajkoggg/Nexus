// The volume shadow copies made while a check ran, from the Windows event log's events (src/snapshots.ts, queue CI4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshotNote, snapshotsOf, type SnapshotEvent } from "../src/snapshots.ts";

const from = "2026-11-20T17:35:50.000Z", to = "2026-11-20T17:53:01.000Z";

test("a copy is its start and the end of the same shadow copy id, asked by the request just before it; only those overlapping the run", () => {
  const events: SnapshotEvent[] = [
    // Before the run, made before it began: not counted.
    { kind: "asked", at: "2026-11-20T17:31:00.000Z", by: "esentutl.exe /vss" },
    { kind: "start", at: "2026-11-20T17:31:01.000Z", id: "a" },
    { kind: "end", at: "2026-11-20T17:31:02.000Z", id: "a" },
    // Begun before the run and still being made when it began: counted.
    { kind: "start", at: "2026-11-20T17:35:40.000Z", id: "b" },
    { kind: "end", at: "2026-11-20T17:35:55.000Z", id: "b" },
    // Within: another copy's end comes first and is not its end; its request is the latest within a minute before it.
    { kind: "asked", at: "2026-11-20T17:40:00.000Z", by: "too early" },
    { kind: "asked", at: "2026-11-20T17:44:19.732Z", by: "taskhostw.exe" },
    { kind: "start", at: "2026-11-20T17:44:20.360Z", id: "c" },
    { kind: "end", at: "2026-11-20T17:44:30.000Z", id: "other" },
    { kind: "end", at: "2026-11-20T17:44:52.859Z", id: "c" },
    // Begun near the end, not made by it: until the run's end, unfinished.
    { kind: "start", at: "2026-11-20T17:52:51.000Z", id: "d" },
    // After the run: not counted.
    { kind: "start", at: "2026-11-20T17:54:00.000Z", id: "e" },
  ];
  assert.deepEqual(snapshotsOf(events, from, to), [
    { at: "2026-11-20T17:35:40.000Z", seconds: 15 },
    { at: "2026-11-20T17:44:20.360Z", seconds: 32.5, by: "taskhostw.exe" },
    { at: "2026-11-20T17:52:51.000Z", seconds: 10, unfinished: true },
  ]);
  assert.deepEqual(snapshotsOf([], from, to), []);
});

test("the note names each copy once, and is empty without one", () => {
  assert.equal(snapshotNote(undefined), "");
  assert.equal(snapshotNote([]), "");
  const one = { at: "2026-11-20T17:44:20.360Z", seconds: 32.5, by: "taskhostw.exe" };
  const note = snapshotNote([one, one, { at: "2026-11-20T17:52:51.000Z", seconds: 10, unfinished: true }]);
  assert.match(note, /^While it ran, Windows made a volume shadow copy \(at 2026-11-20T17:44:20\.360Z, 32\.5 s, asked by taskhostw\.exe; at 2026-11-20T17:52:51\.000Z, still being made at the run's end, 10 s\): file writes/);
  assert.equal(note.match(/17:44:20/g)!.length, 1);
});
