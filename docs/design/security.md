# Security on this machine

What keeps the agents Nexus runs from doing the user's actions. Remote access (the token, Tailscale) is in
[Runtimes and findings from building](runtimes.md#runtimes-and-authentication); this file is about processes on this
machine.

## The local HTTP gap (queue HG)

### The gap, reproduced

The server takes a request from a loopback address without proxy headers as the user's (`isLocal` in
`apps/server/src/remote.ts`). Its write guard (`apps/server/src/main.ts`) asks a write for JSON, an `Origin` whose host
is the `Host`, and no `Sec-Fetch-Site` other than `same-origin`. A browser cannot forge `Origin`; any other program
can. Reproduced on a development instance (HG1, 2026-11-22; port 4329, its own `NEXUS_HOME` in the temp folder, the
fake runtimes, no project), with curl:

| Request | Answer |
|---|---|
| `PATCH /api/settings` `{"defaults":{"max_running":7}}`, no `Origin` | 403 `only the user does this, from the dashboard (agents use the nexus CLI)` |
| the same with `Origin: http://127.0.0.1:4329` | 200, `max_running: 7` written to `settings.yaml` |
| `PATCH /api/settings` `{"runtimes":{"codex":{"sandbox":"danger-full-access"}}}` with that `Origin` | 200: every later Codex session would start without a sandbox |
| `GET /api/remote` (a read: no `Origin` needed) | 200 with the access `token` and the sign-in URL |
| `POST /api/remote/rotate` with that `Origin` | 200: every remote device signed out |

So a local process can do every dashboard action, loosen the agents' own sandboxes, and read the token that remote
devices sign in with. The token is also in `<NEXUS_HOME>/auth.json`, readable by every agent that can read files there.

### Who it matters for

- **The orchestrator on Codex**: its permission profile writes only its drafts and its own events file
  (["An orchestrator on Codex can be kept to its drafts"](runtimes.md#findings-from-building-phase-3)), but loopback
  stays open in every Codex sandbox. The HTTP gap is the one way it has to act as the user; closing it is what the
  switch to Codex waits for.
- **Workers with a free shell** (Claude Code and Codex workers): the gap adds little. Their shell can already write the
  project's `.nexus` files (the deny rules hold only for Claude Code's file tools), the user's events among them. A fix
  makes the HTTP route deliberate instead of one header away; it cannot keep a determined worker out of files the same
  Windows user owns.
- **An agent that reads `NEXUS_HOME`**: today it can take the access token (`auth.json`, or `GET /api/remote`).
- **The orchestrator on Claude Code** runs only `nexus` and read-only git: not affected.

### Options

**A. The server recognises its agents' processes.** Workers already run in a Windows job object with no breakaway
(`apps/server/src/worker-job.cs`): every descendant stays in it. Every agent role (orchestrator, thinking partners,
helpers) would run in one too. For a write, and for `GET /api/remote`, the server finds the process that owns the
connection's client end (the TCP table, `GetExtendedTcpTable`; `netstat -ano` takes about 80 ms, PowerShell's
`Get-NetTCPConnection` about 1.4 s) and refuses it if that process is in an agent's job. The `nexus server` writes
(`update`, `cancel`, `plan`, `cancel-plan`) stay open to the orchestrator's job only, and `away` to none: stricter than
today, where the CLI is the only gate.
- Closes: the sandboxed Codex orchestrator (it cannot start a process outside its job; whether the sandbox user can
  reach WMI or the task scheduler is to be probed in HG2), an agent holding the token (it still cannot write), a
  browser an agent starts (it is in the agent's job). A worker set on it can still leave the job by the task scheduler
  or WMI, but it could write the files anyway.
- The user's paths: unchanged (local browser, phone, CLI, the deploy's HTTP calls from the user's terminal).
- Work: M. A lookup helper beside the job host (C#, as `worker-job.cs`), the other roles in jobs, the guard, tests
  with the fake runtimes. Windows only: elsewhere today's guard stays (documented). A failed lookup lets the request
  through and logs it, so the user is never locked out.

**B. Local writes need the sign-in too.** The local browser signs in once with the access token, as the phone does;
the token is no longer shown to a request without the cookie.
- Closes: the one-header curl. Not an agent that reads `auth.json` (Codex's read-only sandbox reads it) unless the
  file keeps only a hash; then the token and the QR can be shown only once, when made, and adding a phone means a new
  token (or per-device tokens, more work). Not a worker with a free shell. The CLI's `nexus server` calls would need a
  credential, which the orchestrator, an agent, would then hold.
- The user's paths: one sign-in in each local browser; the phone's QR only at a new token; the CLI needs the token.
- Work: M.

**C. A write session needs Windows Hello.** The dashboard asks for a passkey with user verification (WebAuthn: PIN or
fingerprint) and gets a write cookie for some hours; the phone registers its own passkey on the Tailscale address, or
keeps the token.
- Closes: the Codex orchestrator, an agent reading `NEXUS_HOME` (it holds only public keys), most of a free-shell
  worker; not one that writes its own public key into `NEXUS_HOME` or takes the cookie from the browser's profile.
- The user's paths: the local dashboard opens at `http://localhost:4317` (WebAuthn takes no IP address as its relying
  party), a Windows Hello prompt when the write session has lapsed, a passkey for each phone. The CLI's calls as today.
- Work: L (a WebAuthn library, registration and unlock in the dashboard, tests without a real authenticator).

**Recommended: A.** It changes nothing the user does, closes exactly what the switch to Codex waits for, and leaves the
free-shell workers no stronger than their file access already makes them. C can follow later if the threat grows
beyond the agents Nexus runs.

### The decision

The user chose A (2026-11-22, answering HG1's question): "A: a szerver felismeri az agentjei folyamatait (job
object)" (A: the server recognises its agents' processes, by job object). HG2 builds it; B and C are not built.

### Built in HG2

- **Every agent runs in a job.** `AgentHost` gives each session's role to its launch (`agentRole`), and on Windows the
  runtime starts through the job host of `apps/server/src/worker-job.cs` for every role, not only workers. The
  orchestrator's, thinking partners' and review helpers' jobs only mark their processes; below-normal priority and the
  boundary cleanup stay the workers'. What such an agent started now ends when its runtime exits.
- **The guard asks the jobs.** For every write under `/api/` and for `GET /api/remote`, the server sends each live
  agent job host the connection's two ports (`T <id> <client port> <server port>`). The host reads the TCP table
  (`GetExtendedTcpTable`, IPv4 and IPv6, loopback rows only), finds the process that owns the client end and answers
  whether it is a member of its job. A process in an agent's job is refused (403) whatever its headers, its cookie or
  its proxy headers; only the orchestrator's job may send `update`, `cancel`, `plan` and `cancel-plan`, and no agent
  `away`. The host answers off its control reader; a host that does not answer in three seconds, or whose lookup fails
  (it says why, LCF6), counts as no agent and is logged, so the user is never locked out. A loopback connection that no
  running process owns any more is refused too (LCF6, below). With no agent running nothing is asked. Off Windows the guard is today's.
- **Codex's elevated sandbox.** That sandbox runs commands as the accounts of the local group `CodexSandboxUsers`
  (`CodexSandboxOffline`, `CodexSandboxOnline`), possibly started outside the job of the Codex that asked for them. So
  the host also reads the owner's account from the session list (`WTSEnumerateProcessesEx`, which names other
  accounts' processes without opening them) and answers "sandbox" for a member of that group: refused like an agent,
  with no role's rights. One effect beyond Nexus: while a Nexus agent runs, the sandboxed commands of the user's own
  Codex app cannot write to Nexus either.
- **Tests** (`apps/server/test/agent-guard.test.ts`, Windows): a job host names the role owning a grandchild's
  connection and none for the test process's own; a real server with the fake runtimes, whose orchestrator and thinking
  partner run a script in their job (`FAKE-SCRIPT`): the forged browser request, the sandbox setting, the phone's
  cookie with a proxy header, the token read, the rotation and `away` are refused to both; `cancel` passes for the
  orchestrator only; reads pass. The user's dashboard request and the phone's (cookie and proxy header) still write, a
  remote request without the cookie still gets 401, and the user's `nexus server cancel` still reaches the server.

Probed in HG2 (2026-11-22, Codex CLI 0.169.0, `codex sandbox`, no model):

| Sandbox | WMI `Win32_Process.Create` | `schtasks /create` | `Start-Process` | In the caller's job |
|---|---|---|---|---|
| `unelevated` (restricted token, the user's account) | access denied | failed | works, stays in the job | yes: a command's connection was named as the job's |
| `elevated` (the user's setting) | not run | not run | not run | not run: `codex sandbox` failed in this worker session with `CryptUnprotectData failed: 2148073483`, so the account rule above covers it unverified end to end |

The account lookup was checked by hand: the host's own process maps to the user's SID, and `CodexSandboxOnline` is
found in the group while the user is not.

What stays open: a worker with a free shell running as the user can still leave its job (WMI and the task scheduler
work outside the sandbox) and can write the project's files anyway; the guard makes the HTTP route deliberate, not
impossible, for it. The orchestrator on Codex, the case the switch waited for, cannot.

### Its lifecycle paths (LCF6)

Queue LCF went through the guard's paths when an agent is interrupted, goes on in a new process, outlives a server, or
the lookup fails. Three were open, and are closed:

- **An ended client.** The hosts found a connection's owner in the TCP table and asked whether it is in their job. A
  process that sent its whole request and then exited, or reset the connection while it lived on, left no running owner
  in the table by the time the hosts were asked; they answered "nobody's", and the write passed with a browser's
  headers. Reproduced: the hosts asked after the connection closed named 20 of 20 such requests nobody's, and with the
  server's immediate question the first reset request of a fresh host passed. Now a host answers 3 when no running
  process owns the client end (no row, a row naming no process, or a process the session list no longer names), and the
  server refuses such a loopback request while agents run (`ENDED_CLIENT`): whose it was cannot be told, and nobody
  waits for its answer. A connection that is not a loopback one (a device on the network with `NEXUS_HOST` set) is
  never in the hosts' table, gets the same answer, and is let through as before.
- **A failed lookup** (the TCP table or the session list cannot be read) was answered "nobody's" silently. Now it is
  answered 4 with its reason, and the server logs it before it lets the request through, as a host's silence is.
- **An agent that outlives an update's release.** The release waits up to 10 s for the agents' exits; one still running
  after it (a process denying its termination holds its host's K back) ran on beside the successor until the old
  server's exit, and the successor's guard never knew its job. Now the release ends every agent's job left at once, by
  its host (`endAgentJobs`, docs/design/updates.md).

| Group | Path | Test | Result |
|---|---|---|---|
| Interruption | A process of the job sends a write and exits, or resets the connection, before the hosts are asked | `apps/server/test/agent-guard.test.ts` ("an ended client"); the same reset write in every agent script of the server tests | was let through; fixed, refused |
| Interruption | The job ends (stop, kill, Stop at once) while a host is asked | `apps/server/test/worker-process-frames.test.ts` ("closes while asked") | that host answers nobody's; the others still look the owner up (an ended one is refused) |
| Interruption | The job's processes after a stop, a kill or the job host's end | `apps/server/test/worker-job.test.ts`, `apps/server/test/worker-processes.test.ts` | they end with it: no member writes afterwards |
| Continuation | A worker's step (Claude), a thinking partner on Codex, the orchestrator's fresh session after a reset | `apps/server/test/agent-guard.test.ts` ("every new agent process") | refused, as the first process |
| Continuation | Every launch names its session's role (worker, orchestrator, review helper) | `apps/server/test/review-helper.test.ts` ("a checkable level-2 step") | each runs in an agent's job |
| Restart | The server ends: its agents' jobs end with their hosts' pipe | `apps/server/test/agent-guard.test.ts` ("every new agent process"); `apps/server/test/worker-job.test.ts` | the old orchestrator's process ends; nothing of it meets the next server |
| Restart | The next server resumes the orchestrator's session in a process of its own | `apps/server/test/agent-guard.test.ts` ("every new agent process") | refused |
| Restart | An update's release with an agent that does not exit in 10 s | `apps/server/test/project-registry.test.ts`, `apps/server/test/worker-process-frames.test.ts` ("endAgentJobs") | ran on beside the successor; fixed, its job ended at the wait's end |
| Failure | A host does not answer in 3 s | `apps/server/test/worker-process-frames.test.ts` | let through, logged; a late answer changes nothing |
| Failure | A host's lookup fails | `apps/server/test/worker-process-frames.test.ts` | was silent; now let through and logged with its reason |
| Failure | The job is not created (F before the runtime started) | `apps/server/test/worker-process-frames.test.ts` | the host ends, the runtime never runs, the host is never asked |

What stays open: a job host that closes while it is asked answers "nobody's", so a request whose own job ends in that
moment passes when no other agent runs (any other host still looks its owner up). Refusing it would refuse the user's
own write that coincides with an agent's end. And with `NEXUS_HOST` set to every address, an agent connecting through
the machine's own network address is not in the hosts' loopback table: the guard does not see it (the remote access
rules still ask it for the token).
