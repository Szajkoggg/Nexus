// One server writer. Save intent before delivery, and reuse its immutable payload/ID after failure or restart.
import { errorText } from "./errors.ts";
import { z } from "zod";
import { ActionError } from "./actions.ts";
import { previewIdeaHandoff } from "./idea-context.ts";
import { ideaHash } from "./idea-links.ts";
import type { IdeaHandoff } from "./schemas.ts";
import { now, type ProjectStore } from "./store.ts";

const Request = z.object({ request_id: z.string().min(1).max(200), revision: z.string().min(1), selection: z.unknown() }).strict();
type Deliver = (id: string, payload: string) => NonNullable<IdeaHandoff["delivery"]>;

function attempt(store: ProjectStore, record: IdeaHandoff, deliver: Deliver): IdeaHandoff {
  if (record.state === "delivered") return record;
  const at = now();
  let next: IdeaHandoff;
  try { next = { ...record, state: "delivered", delivery: deliver(record.id, record.payload), attempts: [...record.attempts, { at }] }; }
  catch (e) { next = { ...record, state: "failed", attempts: [...record.attempts, { at, error: errorText(e) }] }; }
  const file = store.readIdeaHandoffs();
  store.writeIdeaHandoffs({ ...file, records: file.records.map((r) => r.id === next.id ? next : r) });
  return next;
}

export function sendIdeaHandoff(store: ProjectStore, input: unknown, deliver: Deliver): IdeaHandoff {
  const parsed = Request.safeParse(input);
  if (!parsed.success) throw new ActionError(`Invalid handoff request: ${parsed.error.message}`);
  const req = parsed.data, fingerprint = ideaHash(req), file = store.readIdeaHandoffs();
  const previous = file.records.find((r) => r.id === req.request_id);
  if (previous) {
    if (previous.request !== fingerprint) throw new ActionError("request_id already names another handoff", 409);
    return attempt(store, previous, deliver);
  }
  const preview = previewIdeaHandoff(store, req.selection);
  if (req.revision !== preview.revision) throw new ActionError("The note, status or links changed. Refresh the preview before sending.", 409);
  const record: IdeaHandoff = { id: req.request_id, request: fingerprint, created_at: now(), ...preview.selection,
    revision: preview.revision, payload: preview.payload, state: "pending", attempts: [] };
  store.writeIdeaHandoffs({ ...file, records: [...file.records, record] });
  return attempt(store, record, deliver);
}

export function retryIdeaHandoff(store: ProjectStore, id: string, deliver: Deliver): IdeaHandoff {
  const record = store.readIdeaHandoffs().records.find((r) => r.id === id);
  if (!record) throw new ActionError("Handoff not found", 404);
  return attempt(store, record, deliver);
}
