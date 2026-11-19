// Reading Claude Code's and Codex's transcripts into one shape: the model calls, each with its tokens and the tool calls
// it made (and what came back to them). Pure functions of a transcript's text, so the tests feed made-up transcripts;
// scripts/token-report.ts finds the files. The method is in docs/design/usage.md, "Measuring token use".
import type { TokenCounts } from "@nexus/protocol";
import { zeroTokens } from "./tokens.ts";

/** One tool call of a model call, with what came back to it. */
export interface ToolUse {
  name: string;
  /** A shell tool's command line (Bash, PowerShell, Codex's exec_command). */
  command?: string;
  /** The file a tool named (Read, Grep, Edit, Write, view_image). */
  path?: string;
  /** Characters of text in its result (a Codex exec's output is shared evenly among the tools it ran). */
  result_chars: number;
  /** Images in its result (a picture read back into the context). */
  images: number;
  /** Its result says the full-test lock is busy (scripts/test-lock.ts: "npm test: waiting for …"). */
  lock_wait: boolean;
}

/** One model call (one API response). */
export interface Call {
  /** The response's id (Claude Code's message id, Codex's response id): a forked transcript repeats its parent's calls. */
  id?: string;
  at: string;
  model?: string;
  /** As turns.jsonl keeps them: input not from the cache, output, cache read and written. */
  tokens: TokenCounts;
  tools: ToolUse[];
}

export interface Transcript {
  runtime: "claude" | "codex";
  /** The runtime's own session id (a Nexus session's `native_id`); a sub-agent's is its parent's. */
  session: string;
  /** The working directory the transcript names, where it names one. */
  cwd?: string;
  /** A sub-agent's transcript (Claude Code's `<session>/subagents/agent-*.jsonl`). */
  subagent: boolean;
  calls: Call[];
}

const LOCK_WAIT = /npm test: waiting for /;
/** Parsed JSON read loosely: the transcripts are not ours, and their fields come and go between versions. */
type Loose = any;

/** A transcript's text, or its lines one by one (a long transcript is read in pieces: some pass 1 GB). */
export type Source = string | Iterable<string>;

/** The records of a transcript; `wanted` skips a line before parsing it (the large request lines nobody needs). */
function* records(source: Source, wanted: (line: string) => boolean = () => true): Generator<Loose> {
  for (const line of typeof source === "string" ? source.split("\n") : source) {
    if (!line.trim() || !wanted(line)) continue;
    try { yield JSON.parse(line); } catch { /* a torn last line */ }
  }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The text and images of a tool result's content (a string, or a list of text and image blocks). */
function resultContent(content: unknown): { text: string; images: number } {
  if (typeof content === "string") return { text: content, images: 0 };
  let text = "";
  let images = 0;
  if (Array.isArray(content)) {
    for (const c of content as Loose[]) {
      if (c?.type === "text" || c?.type === "input_text" || c?.type === "output_text") text += String(c.text ?? "");
      else if (c?.type === "image" || c?.type === "input_image") images++;
      else if (c?.type === "tool_result") { const r = resultContent(c.content); text += r.text; images += r.images; }
    }
  }
  return { text, images };
}

function claudeTool(block: Loose): ToolUse {
  const input: Loose = typeof block.input === "string" ? safeParse(block.input) : (block.input ?? {});
  const name = String(block.name ?? "");
  const t: ToolUse = { name, result_chars: 0, images: 0, lock_wait: false };
  if (typeof input?.command === "string") t.command = input.command;
  const path = input?.file_path ?? input?.notebook_path ?? input?.path;
  if (typeof path === "string") t.path = path;
  return t;
}

function safeParse(s: string): Loose {
  try { return JSON.parse(s); } catch { return {}; }
}

/**
 * A Claude Code transcript (`~/.claude/projects/<dir>/<session>.jsonl`, or a sub-agent's). One API response is written
 * as several lines (one per content block) with the same message id and usage: they make one call. The results come in
 * the following user lines, by tool_use_id.
 */
export function parseClaude(source: Source, o: { session: string; subagent: boolean }): Transcript {
  const calls = new Map<string, Call>();
  const tools = new Map<string, ToolUse>();
  let cwd: string | undefined;
  const wanted = (line: string) => !cwd || line.includes('"type":"assistant"') || line.includes('"type":"user"');
  for (const r of records(source, wanted)) {
    if (!cwd && typeof r?.cwd === "string") cwd = r.cwd;
    if (r?.type === "assistant" && r.message?.id && r.message.usage && r.message.model !== "<synthetic>") {
      const u = r.message.usage;
      let c = calls.get(r.message.id);
      if (!c) {
        c = { id: r.message.id, at: String(r.timestamp ?? ""), model: r.message.model, tokens: zeroTokens(), tools: [] };
        calls.set(r.message.id, c);
      }
      // The lines of one response repeat its usage (the output may grow while it streams): the largest of each.
      c.tokens.input = Math.max(c.tokens.input, num(u.input_tokens));
      c.tokens.output = Math.max(c.tokens.output, num(u.output_tokens));
      c.tokens.cache_read = Math.max(c.tokens.cache_read, num(u.cache_read_input_tokens));
      c.tokens.cache_creation = Math.max(c.tokens.cache_creation, num(u.cache_creation_input_tokens));
      for (const b of Array.isArray(r.message.content) ? r.message.content : []) {
        if (b?.type !== "tool_use" || !b.id || tools.has(b.id)) continue;
        const t = claudeTool(b);
        tools.set(b.id, t);
        c.tools.push(t);
      }
    } else if (r?.type === "user" && Array.isArray(r.message?.content)) {
      for (const b of r.message.content) {
        if (b?.type !== "tool_result") continue;
        const t = tools.get(b.tool_use_id);
        if (!t) continue;
        const { text: s, images } = resultContent(b.content);
        t.result_chars += s.length;
        t.images += images;
        if (LOCK_WAIT.test(s)) t.lock_wait = true;
      }
    }
  }
  return { runtime: "claude", session: o.session, cwd, subagent: o.subagent, calls: [...calls.values()] };
}

/** A JavaScript string literal's value, as Codex writes them in its exec cells ("…", '…' or `…`). */
function unquote(lit: string): string {
  const body = lit.slice(1, -1);
  if (lit.startsWith('"')) { try { return JSON.parse(lit) as string; } catch { /* fall through */ } }
  return body.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
}

const STRING = String.raw`("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\x60(?:[^\x60\\]|\\.)*\x60)`;

/**
 * The tools a Codex exec cell runs (`tools.exec_command({cmd:"…"})`, `tools.view_image({path:"…"})`, …), in order: an
 * exec cell is JavaScript that can call several tools in one model call. Only literal arguments are read.
 */
export function execTools(js: string): ToolUse[] {
  const out: ToolUse[] = [];
  const call = /tools\.(\w+)\s*\(/g;
  for (let m = call.exec(js); m; m = call.exec(js)) {
    const t: ToolUse = { name: m[1]!, result_chars: 0, images: 0, lock_wait: false };
    // The argument: up to the next tools. call, where it names cmd or path.
    const next = js.indexOf("tools.", m.index + m[0].length);
    const arg = js.slice(m.index + m[0].length, next < 0 ? undefined : next);
    const cmd = new RegExp(String.raw`\bcmd\s*:\s*` + STRING).exec(arg);
    if (cmd) t.command = unquote(cmd[1]!);
    const path = new RegExp(String.raw`\bpath\s*:\s*` + STRING).exec(arg);
    if (path) t.path = unquote(path[1]!);
    out.push(t);
  }
  return out;
}

/**
 * A Codex transcript (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`). The tool calls of a response come before its
 * `token_usage_record` (one per response: the call), their outputs after it, by call_id. Codex's input counts its
 * cached part, so input here is input less cached (as apps/server/src/codex.ts takes it). Older transcripts without
 * usage records fall back to the `token_count` events' last usage.
 */
export function parseCodex(source: Source): Transcript {
  let meta: Loose = {};
  let hasRecords = false;
  const calls: Call[] = [];
  const fallback: Call[] = [];
  const byCallId = new Map<string, ToolUse[]>();
  // The tools not yet given to a call: one list for the usage records, one for the token_count fallback.
  let pending: ToolUse[] = [];
  let pendingFallback: ToolUse[] = [];
  let lastTotal = "";
  let model: string | undefined;
  const call = (at: string, u: Loose, tools: ToolUse[]): Call => {
    const cached = num(u.cached_input_tokens);
    return {
      at, model, tools,
      tokens: { input: Math.max(0, num(u.input_tokens) - cached), output: num(u.output_tokens), cache_read: cached, cache_creation: num(u.cache_write_input_tokens) },
    };
  };
  for (const r of records(source)) {
    const p = r?.payload;
    if (!p) continue;
    if (r.type === "session_meta") meta = p;
    else if (r.type === "turn_context" && typeof p.model === "string") model = p.model;
    else if (r.type === "event_msg" && p.type === "thread_settings_applied" && typeof p.thread_settings?.model === "string") model = p.thread_settings.model;
    else if (r.type === "response_item" && (p.type === "custom_tool_call" || p.type === "function_call")) {
      let ts: ToolUse[];
      if (p.type === "custom_tool_call" && p.name === "exec") {
        ts = execTools(String(p.input ?? ""));
        if (!ts.length) ts = [{ name: "exec", result_chars: 0, images: 0, lock_wait: false }];
      } else {
        const args = typeof p.arguments === "string" ? safeParse(p.arguments) : (p.arguments ?? {});
        const t: ToolUse = { name: String(p.name ?? p.type), result_chars: 0, images: 0, lock_wait: false };
        if (typeof args.cmd === "string") t.command = args.cmd;
        if (typeof args.path === "string") t.path = args.path;
        ts = [t];
      }
      pending.push(...ts);
      pendingFallback.push(...ts);
      if (p.call_id) byCallId.set(p.call_id, ts);
    } else if (r.type === "response_item" && (p.type === "custom_tool_call_output" || p.type === "function_call_output")) {
      const ts = byCallId.get(p.call_id);
      if (!ts?.length) continue;
      const out = p.output;
      const { text: s, images } = typeof out === "object" && !Array.isArray(out) && out ? resultContent(out.content ?? out.output) : resultContent(out);
      const share = Math.round(s.length / ts.length);
      const lock = LOCK_WAIT.test(s);
      const viewers = ts.filter((t) => t.name === "view_image");
      (viewers.length ? viewers : ts)[0]!.images += images;
      for (const t of ts) { t.result_chars += share; if (lock) t.lock_wait = true; }
    } else if (r.type === "token_usage_record" && p.usage) {
      hasRecords = true;
      calls.push({ ...call(String(r.timestamp ?? ""), p.usage, pending), id: typeof p.response_id === "string" ? p.response_id : undefined });
      pending = [];
    } else if (r.type === "event_msg" && p.type === "token_count" && p.info?.last_token_usage) {
      // A token_count event repeats when nothing new happened: only a changed total is a new call.
      const total = JSON.stringify(p.info.total_token_usage ?? {});
      if (total === lastTotal) continue;
      lastTotal = total;
      fallback.push(call(String(r.timestamp ?? ""), p.info.last_token_usage, pendingFallback));
      pendingFallback = [];
    }
  }
  // A sub-agent's thread (the guardian reviewing an approval, a spawned agent) names its parent: it is the parent's.
  const parent = typeof meta.parent_thread_id === "string" ? meta.parent_thread_id : undefined;
  return {
    runtime: "codex", session: String(parent ?? meta.id ?? meta.session_id ?? ""), cwd: typeof meta.cwd === "string" ? meta.cwd : undefined,
    subagent: !!parent, calls: hasRecords ? calls : fallback,
  };
}
