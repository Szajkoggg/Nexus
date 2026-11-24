// The events table of docs/protocol/sessions.md against the `Event` union of schemas.ts: the same types, the same
// fields with the same optionality, and the role each type is documented for against the sets the loader uses
// (ORCHESTRATOR_ONLY, WORKER_ONLY, USER_ONLY, CONVERSATION_ONLY). The table is read as text, so a row that drifts from
// the code (a field renamed, made optional, a type added or dropped, a role changed) fails here, naming the row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONVERSATION_ONLY, Event, ORCHESTRATOR_ONLY, USER_ONLY, WORKER_ONLY } from "../src/schemas.ts";

const SESSIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "protocol", "sessions.md");
const BASE_KEYS = new Set(["v", "id", "at", "session", "type"]);

interface Row { type: string; fields: Map<string, boolean>; meaning: string }

/** Splits at the commas outside backticks, parentheses, brackets and braces. */
function splitTop(text: string): string[] {
  const out: string[] = []; let depth = 0; let tick = false; let cur = "";
  for (const c of text) {
    if (c === "`") tick = !tick;
    else if (!tick && "([{".includes(c)) depth++;
    else if (!tick && ")]}".includes(c)) depth--;
    if (c === "," && !tick && depth === 0) { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** The field names of a table cell, each with whether it is optional (`name?`); "one of", "or" and glosses are read through. */
function cellFields(cell: string): Map<string, boolean> {
  const fields = new Map<string, boolean>();
  // A parenthesis is a gloss ("(`next` or `orchestrator`)"), not a field; a semicolon separates fields like a comma.
  for (const part of splitTop(cell.replaceAll(/[(][^()]*[)]/g, "").replaceAll(";", ","))) {
    for (const piece of part.split(/\s+or\s+(?=`)/)) {
      const m = /^(?:one of\s+)?`([a-z_]+)(\?)?(?:[:` ])/.exec(piece.trim() + " ") ?? /^(?:one of\s+)?`([a-z_]+)(\?)?`/.exec(piece.trim());
      if (m) fields.set(m[1]!, !!m[2]);
    }
  }
  return fields;
}

/** The rows of the events table: type, fields, meaning. */
function eventRows(markdown: string): Row[] {
  const rows: Row[] = [];
  let inTable = false;
  for (const line of markdown.split("\n")) {
    if (/^\| Type \| Fields \| Meaning \|/.test(line)) { inTable = true; continue; }
    if (!inTable) continue;
    if (!line.startsWith("|")) break;
    if (/^\|---/.test(line)) continue;
    const m = /^\| `([a-z_.]+)` \| (.*?) \| (.*) \|$/.exec(line);
    assert.ok(m, `a row of the events table: ${line.slice(0, 80)}`);
    rows.push({ type: m[1]!, fields: cellFields(m[2]!), meaning: m[3]! });
  }
  return rows;
}

/** The schema's fields of each event type: name, optional or not. */
function schemaFields(): Map<string, Map<string, boolean>> {
  // A field with a default is always there once read, and one typed unknown cannot say it is required: both count as
  // required for the table, which lists what the writer gives.
  const out = new Map<string, Map<string, boolean>>();
  for (const option of Event.options) {
    const shape = option.shape as Record<string, { isOptional(): boolean; def: { type?: string; value?: string } }>;
    const type = (shape.type as unknown as { value: string }).value;
    out.set(type, new Map(Object.entries(shape).filter(([k]) => !BASE_KEYS.has(k)).map(([k, v]) => [k, v.isOptional() && !["default", "unknown", "any"].includes(v.def.type ?? "")])));
  }
  return out;
}

const rows = eventRows(readFileSync(SESSIONS, "utf8"));
const schema = schemaFields();

test("the events table lists exactly the types of the Event union", () => {
  assert.deepEqual(rows.map((r) => r.type).sort(), [...schema.keys()].sort());
  assert.equal(new Set(rows.map((r) => r.type)).size, rows.length, "no type twice");
});

test("each row names the fields of its event, with the same optionality", () => {
  const wrong: string[] = [];
  for (const r of rows) {
    const code = schema.get(r.type)!;
    // `tags.proposed`: "one of area, activity, rename": the schema holds them as optional fields of one object.
    const docNames = [...r.fields.keys()].sort(); const codeNames = [...code.keys()].sort();
    if (docNames.join() !== codeNames.join()) { wrong.push(`${r.type}: the table has ${docNames.join(", ")}; the schema ${codeNames.join(", ")}`); continue; }
    for (const [name, optional] of r.fields) {
      const codeOptional = code.get(name)!;
      // Fields documented as a choice ("one of", "or") are optional in the schema, whatever the table's mark.
      const choice = r.type === "tags.proposed" || (r.type === "recurring.set" && (name === "every" || name === "after_queues"));
      if (!choice && optional !== codeOptional) wrong.push(`${r.type}.${name}: the table says ${optional ? "optional" : "required"}, the schema ${codeOptional ? "optional" : "required"}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test("the role a row documents is the set the loader uses", () => {
  const phrases: [string, ReadonlySet<string>][] = [
    ["Orchestrator only", ORCHESTRATOR_ONLY], ["Worker only", WORKER_ONLY], ["User only", USER_ONLY], ["Thinking partners only", CONVERSATION_ONLY],
  ];
  const wrong: string[] = [];
  for (const [phrase, set] of phrases) {
    for (const r of rows) {
      const says = r.meaning.startsWith(phrase);
      if (says !== set.has(r.type) && !(phrase === "Orchestrator only" && set.has(r.type) && /^(The orchestrator's|Orchestrator,)/.test(r.meaning))) {
        wrong.push(`${r.type}: ${says ? `the table says "${phrase}"` : `the table does not say "${phrase}"`}, the loader ${set.has(r.type) ? "holds it to" : "does not hold it to"} that role`);
      }
    }
  }
  assert.deepEqual(wrong, []);
});

test("the table's reading handles its harder cells", () => {
  assert.deepEqual([...cellFields("`queue`, `step`, `text`, `pct?`")], [["queue", false], ["step", false], ["text", false], ["pct", true]]);
  assert.deepEqual([...cellFields("`queue`, `step`, `items: [{path or url, label}]`, `round?`")].map((x) => x[0]), ["queue", "step", "items", "round"]);
  assert.deepEqual([...cellFields("one of `area`, `activity`, `rename` (`from`, `to`); `reason?`")].map((x) => x[0]), ["area", "activity", "rename", "reason"]);
  assert.deepEqual([...cellFields("`every?` or `after_queues?`, `reason`")], [["every", true], ["after_queues", true], ["reason", false]]);
});
