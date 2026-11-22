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
