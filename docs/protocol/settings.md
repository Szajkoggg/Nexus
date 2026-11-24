# Settings

Part of [the protocol](../PROTOCOL.md).

## Global settings

`<NEXUS_HOME>/settings.yaml` holds the global settings, which every project follows where it has no value of its
own. Written only by the server; created at its first start with the built-in defaults (below), so nothing changes
for a project then. Same paths as in `project.yaml`:

```yaml
protocol: 1
defaults: { stop_conditions: [], review_level: 2, review_send_back_limit: 2, check_fix_limit: 3, context_reuse_tokens: 300000,
            context_care: true, protect_nexus: true, push_accepted: false, provisional_counts: true,
            merge_back: false, resolve_conflicts: false, usage_pause_threshold: 0.9, max_running: 2 }
runtimes:
  default: claude
  claude: { permission_mode: acceptEdits }            # model, effort: none (the runtime's default)
  codex:  { sandbox: workspace-write, approval_policy: never }   # model, effort, approvals_reviewer: none
conversations: { runtime: claude, web: search }       # model, effort: none
orchestrator: { runtime: claude, notify: true, context_threshold_tokens: 500000 }   # model, effort: none
languages: {}                                         # reader: none (the language the user writes in)
kinds:                                                # each kind's runtime, model, effort and fallback (see "Kinds and their defaults")
  mechanical: { runtime: claude, model: claude-sonnet-5-5, effort: low, fallback: [{ runtime: codex, model: gpt-6-luna, effort: low }] }
  code:       { runtime: claude, model: claude-opus-5-5, effort: high, fallback: [{ runtime: codex, effort: high }] }
  # debugging and research as code; docs: claude-sonnet-5-5, medium, fallback codex medium; design: claude-opus-5-5, high, fallback [wait]
review_helper: { enabled: true, runtime: claude, model: claude-sonnet-5-5, effort: medium, audit_rate: 0.1 }   # see "The review helper"
```

**The effective value** of a setting in a project is its own value where `project.yaml` has one, else the global
value. A setting without a default (a model, an effort, `approvals_reviewer`) may have the project's own `null`: "none,
the runtime's default", even where the global value names one. `ProjectStore.readProject` gives the effective
settings, the form every reader uses; `readStoredProject` gives the file as it is.

**Writing.** Every writer of `project.yaml` (the settings action, the allow rule from a refusal, the orchestrator's
model, effort and session, `nexus import`) goes through `ProjectStore.updateProject`: a setting the change gives
another effective value becomes the project's own; one it leaves alone keeps its state, following or own. The settings
action's `follow` (a list of keys, `runtimes.claude.model`) makes those settings follow the global value again. A
change of a global value reaches every project that follows it at once.

**Running sessions** get changed settings at their next step or message, never inside a turn:

- A worker: its run's values from the defaults are resolved again when the next step opens (above). Settings its
  process was started with (Claude Code's permission mode, allow rules and the `.nexus` protection; Codex's sandbox,
  approval policy and reviewer; a model or effort it took from the defaults) are compared with the effective ones then;
  if they differ, the idle process is ended and the session resumed with them before the step opens (Claude Code
  `--resume`, Codex `thread/resume`). A model or effort of its own changes as in ["Runtime, model and effort per step"](runtimes.md#runtime-model-and-effort-per-step).
- The orchestrator runs on the project's effective `orchestrator.runtime` (`codex`, else Claude Code), `model` and
  `effort`; its session records them. Before a message, a process started with other settings is replaced: at once
  when idle; when working, after its turn (that message still goes into the running turn). Another runtime starts a
  fresh session (see ["The orchestrator"](orchestrator.md#the-orchestrator)). An effort Claude Code does not take (`ultra`) is refused by
  `POST …/orchestrator/settings` on Claude Code; one left from Codex is not passed to Claude Code (it runs at its
  default, and the chat says so).
- A thinking partner runs on its own model and effort if its creation named them, else on the project's effective
  `conversations.model` and `effort` (when it runs on `conversations.runtime`). It is replaced before a message in the
  same way. An effort its runtime does not take refuses the message, with the reason.

**The migration** turns a `project.yaml` without `follows_global` into this form once, when the server starts (before
anything reads the project): the file's values meant what the built-in defaults made of them; each that equals the
global value then follows it, each that differs becomes the project's own (a missing model or effort against a global
one: `null`). The effective settings do not change. It writes only such a file, and a second run writes nothing.

**Which kind each setting is:**

| Kind | Settings |
|---|---|
| Global, with a project override | `defaults`: `stop_conditions`, `review_level`, `review_send_back_limit`, `context_reuse_tokens`, `context_care`, `protect_nexus`, `push_accepted`, `provisional_counts`, `merge_back`, `resolve_conflicts`, `usage_pause_threshold`, `max_running` (see ["One queue per checkout, and a limit"](git.md#one-queue-per-checkout-and-a-limit)), `check_fix_limit` (see ["Checks run by Nexus"](checks.md#checks-run-by-nexus)). `runtimes`: `default`; `claude`: `model`, `effort`, `permission_mode`; `codex`: `model`, `effort`, `sandbox`, `approval_policy`, `approvals_reviewer`. `conversations`: `runtime`, `model`, `effort`, `web`. `orchestrator`: `runtime`, `model`, `effort`, `fallback`, `notify`, `context_threshold_tokens` (`context_threshold`, its old key, is ignored when read). `languages`: `reader`. `kinds.<kind>`: `runtime`, `model`, `effort` (a model or effort may be the project's own `null`: the project's for that runtime), `fallback`. `review_helper`: `enabled`, `runtime`, `model`, `effort` (likewise `null`), `audit_rate` (see ["The review helper"](review.md#the-review-helper)) |
| Project only | `name`, `defaults.worktree_dir`, `defaults.worktree_setup`, `defaults.worktree_setup_inputs` (see ["Without a model"](git.md#without-a-model)), `defaults.checks`, `runtimes.claude.allowed_tools` (the project's own allow rules), `runtimes.codex.mcp_servers` (the user's Codex MCP servers, by name, that Codex workers keep; empty by default), `conversations.notes_dir`, `languages.working` (`id` and `root` identify the project) |
| Global only | Remote access (`<NEXUS_HOME>/auth.json`, `push.json`), the deploy push (`deploy.json`), the server; each stays in its own file |
| State, not a setting | `orchestrator.session` |

The orchestrator's settings count only for a project that has an orchestrator section (it has had one); the section
is made with its first session.

### Languages

Two settings say which language what is written is in. Each is one of the offered languages, stored by its code:
`hu` Hungarian, `en` English, `da` Danish, `de` German, `es` Spanish, `fr` French, `pl` Polish, `it` Italian
(`packages/protocol/src/languages.ts`, `LANGUAGES`).

- **`languages.reader`, the reader's language** (global, with a project override): what everything written to the
  user is in: chat replies, step summaries, questions, progress lines, notifications, and the text of queues (title,
  description, goals, acceptance, stop conditions, checks, review notes; ids and YAML keys stay English). It has no default: none means "the language the
  user writes in", today's behaviour. A project's own `null` is that too, where the global value names a language.
- **`languages.working`, the working language** (project only, default `en`): what the project's agents work in:
  files, code, comments, commits, context cards, notes. It must agree with the project's own rules (its AGENTS.md):
  the setting is what Nexus tells the agents, the project's rules are the project's.

**How agents are told** (`apps/server/src/prompts.ts`, from the project's effective settings):

- **With the defaults** (no reader's language, working language English) every text is as it was before these
  settings: the orchestrator and partners reply in the language the user writes in, and what they write into files
  and queues is in English; the worker's texts name no language.
- **The worker**: its briefing ends with a language line ("write what is meant for the user in <reader's language>:
  step summaries, questions, progress lines, stop and failure reasons, labels of review material; work in <working
  language>: files, code, comments, commit messages, context summaries"). With no reader's language set, the line
  says "the language the user writes in". A briefing is fixed when its process starts, so the same line also ends
  each step's opening and each inbox message as delivered: a change reaches a running worker with its next message or
  step. A changed briefing also counts as a changed launch setting, so the worker is resumed in a new process before
  its next step ("Running sessions").
- **The orchestrator**: replies, and the text of the queues it drafts (title, description, goals, acceptance, stop
  conditions, checks, review notes; ids and YAML keys stay English), are in the reader's language; everything else it
  writes into files is in the working language. With no reader's language set, queue text is in the working language
  (as before). It tells its queue-reviewer which language the queue's text is to be in; the reviewer checks it. A
  change reaches it at its next message: its process is resumed with the new briefing.
- **A thinking partner** replies in the reader's language (none: the language the user writes in) and writes its notes
  in the working language; its hand-over summary for the orchestrator is in the working language. A change reaches it
  at its next message, as for the orchestrator.
