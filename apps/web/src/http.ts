// The dashboard's requests to the server, each reply checked: the typed endpoint functions (api.ts and the components
// that own a reply's type) are built on `request`, so none parses an error reply as an answer or misses a refusal.

/**
 * A request the server refused, with its HTTP status. The message is the server's reason (in English), else the status
 * text; `reason` only the server's own, undefined when it gave none.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly reason: string | undefined;
  constructor(message: string, status: number, reason?: string) { super(message); this.status = status; this.reason = reason; }
}

/** The error of a refused reply: the server's `error`, else the status text. */
const refused = (r: Response, body: unknown) => {
  const reason = (body as { error?: string } | undefined)?.error;
  return new HttpError(reason ?? r.statusText, r.status, reason);
};

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

let replied: ((url: string, r: Response) => void) | undefined;
/** Told of every checked reply (api.ts takes where a write left the live stream from its header). */
export function onReply(f: (url: string, r: Response) => void): void { replied = f; }

/**
 * A request whose reply is checked: resolves with the reply's JSON body (undefined when it has none); rejects with an
 * HttpError holding the server's reason (else the status text) and status. A write always sends a JSON body (`{}` when
 * none is given): the server takes writes as JSON only.
 */
export async function request<T>(url: string, o: { method?: Method; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = o.method ?? "GET";
  const write = method !== "GET";
  const r = await fetch(url, {
    method, ...(o.signal ? { signal: o.signal } : {}),
    ...(write ? { headers: { "content-type": "application/json" }, body: JSON.stringify(o.body ?? {}) } : {}),
  });
  const body = await r.json().catch(() => undefined) as unknown;
  if (!r.ok) throw refused(r, body);
  replied?.(url, r);
  return body as T;
}

/** A GET whose body the caller reads itself (headers first, maybe not at all); a refusal rejects as in `request`. */
export async function open(url: string, signal?: AbortSignal): Promise<Response> {
  const r = await fetch(url, signal ? { signal } : {});
  if (!r.ok) throw refused(r, await r.json().catch(() => undefined));
  return r;
}
