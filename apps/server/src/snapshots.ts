// Windows volume shadow copies made while a check ran (queue CI4). While Windows makes one (a restore point, Windows'
// Point-in-time restore task, a backup tool's copy, Windows Update), file writes on the volume stop until it is made:
// on the user's machine for up to 32 s, longer each day as copies piled up. Every test waiting for something in that
// time can time out at once, whatever the work under test did. Nexus cannot prevent it (it is the machine's setting and
// needs an administrator); it says so beside a check's failure, so that the worker, the orchestrator and the user see
// the machine's cause instead of opening a fix queue for tests that are not at fault (docs/design/tests.md, "Volume
// shadow copies stop the tests"; docs/protocol/checks.md, "Checks run by Nexus").
//
// The Windows event log has each copy, readable without administrator rights: the volume snapshot driver's event 126
// (the copy's diff area added: its start), NTFS's event 4 mounting \Device\HarddiskVolumeShadowCopyN (it is made: its
// end), both carrying the shadow copy's id; and VSS's event 8231 in the Application log, the command line that asked
// for it. Their fields are read by position, not from the messages, which are in the system's language.
import { execFile } from "node:child_process";
import type { VolumeSnapshot } from "@nexus/protocol";

/** Reads the shadow copies whose making overlapped `from`..`to` (ISO times). */
export type SnapshotReader = (from: string, to: string) => Promise<VolumeSnapshot[]>;

/** One event as the PowerShell query returns it (`at` in UTC, ISO). */
export interface SnapshotEvent { kind: "start" | "end" | "asked"; at: string; id?: string; by?: string }

/** How far back a copy's start is looked for: one that began before the run and was still being made counts. */
const LOOKBACK_MS = 5 * 60_000;
/** The request (VSS 8231) comes shortly before its copy's start; one further back belongs to another copy. */
const ASKED_WITHIN_MS = 60_000;

/**
 * The copies from the events: each start paired with the end of the same shadow copy id (a start without an end is
 * still being made, until `to`), its asker the latest request before it; those that overlap `from`..`to`, oldest first.
 */
export function snapshotsOf(events: readonly SnapshotEvent[], from: string, to: string): VolumeSnapshot[] {
  const t0 = Date.parse(from), t1 = Date.parse(to);
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const out: VolumeSnapshot[] = [];
  for (const s of sorted.filter((e) => e.kind === "start")) {
    const start = Date.parse(s.at);
    const end = sorted.find((e) => e.kind === "end" && e.id && e.id === s.id && Date.parse(e.at) >= start);
    const stop = end ? Date.parse(end.at) : t1;
    if (start > t1 || stop < t0) continue;
    const asked = sorted.filter((e) => e.kind === "asked" && Date.parse(e.at) <= start && start - Date.parse(e.at) <= ASKED_WITHIN_MS).at(-1);
    out.push({ at: new Date(start).toISOString(), seconds: Math.round((stop - start) / 100) / 10, ...(end ? {} : { unfinished: true }), ...(asked?.by ? { by: asked.by } : {}) });
  }
  return out;
}

/** The query, one JSON array of SnapshotEvent; the times are ISO strings this module made (toISOString). */
const query = (from: string, to: string) => `
$ErrorActionPreference = 'SilentlyContinue'
$from = [datetime]::Parse('${from}', $null, [Globalization.DateTimeStyles]::RoundtripKind).ToLocalTime()
$to = [datetime]::Parse('${to}', $null, [Globalization.DateTimeStyles]::RoundtripKind).ToLocalTime()
$utc = { param($t) $t.ToUniversalTime().ToString('o') }
$out = @()
$out += @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-VolumeSnapshot-Driver/Operational'; Id = 126; StartTime = $from; EndTime = $to } | ForEach-Object { @{ kind = 'start'; at = (& $utc $_.TimeCreated); id = [string]$_.Properties[1].Value } })
$out += @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Ntfs/Operational'; Id = 4; StartTime = $from; EndTime = $to.AddMinutes(5) } | Where-Object { [string]$_.Properties[6].Value -like '*ShadowCopy*' } | ForEach-Object { @{ kind = 'end'; at = (& $utc $_.TimeCreated); id = [string]$_.Properties[0].Value } })
$out += @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'VSS'; Id = 8231; StartTime = $from.AddMinutes(-1); EndTime = $to } | ForEach-Object { @{ kind = 'asked'; at = (& $utc $_.TimeCreated); by = [string]$_.Properties[1].Value } })
ConvertTo-Json -InputObject @($out) -Compress
`;

/**
 * The shadow copies made while `from`..`to` ran, from the Windows event log; none elsewhere, and none when the log
 * cannot be read (a failure here never changes what the check's result is).
 */
export const readSnapshots: SnapshotReader = async (from, to) => {
  if (process.platform !== "win32") return [];
  const since = new Date(Date.parse(from) - LOOKBACK_MS).toISOString();
  const text = await new Promise<string>((resolve) => {
    execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", query(since, new Date(Date.parse(to)).toISOString())],
      { windowsHide: true, timeout: 60_000, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? "" : stdout));
  });
  try {
    const events = JSON.parse(text.trim() || "[]") as SnapshotEvent[];
    return snapshotsOf(Array.isArray(events) ? events : [], from, to);
  } catch { return []; }
};

/** The copies in words, for a check's failure: when, how long, and who asked. */
export function snapshotNote(snapshots: readonly VolumeSnapshot[] | undefined): string {
  const unique = (snapshots ?? []).filter((s, i, all) => all.findIndex((x) => x.at === s.at) === i);
  if (!unique.length) return "";
  const each = unique.map((s) => `at ${s.at}, ${s.unfinished ? "still being made at the run's end, " : ""}${s.seconds} s${s.by ? `, asked by ${s.by}` : ""}`);
  return `While it ran, Windows made a volume shadow copy (${each.join("; ")}): file writes on the volume stop until one is made, so tests waiting then can time out together, whatever the work did. A failure whose tests timed out in that time is the machine's (docs/design/tests.md, "Volume shadow copies stop the tests").`;
}
