# Correcting the MT, IO and ST2 relationships

Use the supported dashboard after this UI is deployed by the user. This guide is for the user's decisions;
no agent should apply them. The real notes, matches and queue definitions were read only. The procedure is
exercised by `node scripts/verify-ideas-ui.ts` against disposable synthetic projects and fake runtimes.

Open **Ideas > Overview > Manage links**. This button remains available when **Pending** is zero, including
after the last suggestion was decided. Use **All** or **Linked** and **Find a queue or note**. Verify the full
queue ID, origin **Historical match**, file and date on each card; a similarly named source is a separate origin.
The expandable evidence shows the match's own original quote and any current suggestion separately.

| Queue | Exact historical match to remove | Reason to review |
|---|---|---|
| MT | `docs/ideas/user-notes-2026-11-15.md#2026-11-15` | The umbrella note points to the notes-maintenance decision in `queue-templates.md`, dated 15 November. |
| IO | `docs/ideas/tags.md#2026-11-14` | The occurrence in IO describes the status/reference format as context; it does not implement the tags decision. |
| ST2 | `docs/ideas/tags.md#2026-11-14` | ST2 consumes tags. Its own description says FB delivers them. |

For each of these three cards, choose **Remove link**, read the From/To preview, enter the reason and choose
**Save correction**. The record becomes removed and remains visible under All and Correction history. Clear the
search before the next queue. Do not remove the entire queue or any other match. If another origin still links the
same queue/date, the card explains that; evaluate it separately, without changing a closed queue definition.

Then choose **Add link**. Search for MT with **Find a queue**, select **MT**, search `queue-templates` with
**Find a note or decision**, and select **Queue templates / 2026-11-15** in **Note and Decided date**. Check the
full reference `docs/ideas/queue-templates.md#2026-11-15` and the displayed complete date. It contains the recurring
notes-maintenance template covering memory notes, the Ideas notes, and AGENTS/DESIGN/PROTOCOL. Give that as the
reason, then **Save correction**. This adds a manual origin; it does not assert full implementation.

An alternative is **Change target** on MT's wrong historical match, selecting the same correct date and supplying
the reason. That performs the removal and manual addition in one atomic action. Its undo restores both sides.
Use this alternative instead of the separate MT removal/addition, not in addition to them. If the correct edge is
already effective, inspect its origins instead of adding a duplicate; the API rejects a duplicate manual edge.

After the four corrections, verify these relationships remain:

- MT to `docs/ideas/software-dev-features.md#2026-11-14`.
- MT to `docs/ideas/queue-templates.md#2026-11-14` as well as the new 15 November link.
- IO's own Ideas-overview relationship, ST2's statistics relationships, and FB's tags relationship.
- All unrelated origins and historical handovers.

Open **Correction history** for time, actor, reason, before/after and **Undo correction**. Undo itself asks for a
reason and adds history. A newer change to an affected origin prevents undo; refresh and inspect that newer
decision. This preserves corrections made in another tab. If a save fails, the reason stays; **Retry the same save**
reuses its request ID even if the server committed before the connection failed. **Refresh and review** discards
that old request, keeps the draft fields and lets you review current data before making a new decision.

On each affected note, linked-work status may change and a prior implementation assessment may need review.
That is expected: a changed effective link set requires another user check. Do not automatically replace it with
full confirmation. Use the entry's exact date and **Review implementation** or **Change status** after reviewing
the substantive outcomes. **Related work** starts closed and contains scoped excerpts and Full report links.

## Reproducing the verification

Run `npm run build -w @nexus/web`, then `node scripts/verify-ideas-ui.ts <temporary report directory>`.
The script seeds its own projects, checks the 12 accepted view/width combinations with the capture tool's browser
and layout-faults engine, then exercises the corrections, preservation of other origins, undo, zero-pending
reopening, uncertain-save retry, date-specific confirmation, stale data, reload and Back. It checks queue/note
bytes around relationship actions and shuts down its server and browser in `finally`. It never launches a model.
`scripts/capture/examples/ideas-corrections.yaml` and `ideas-ui.yaml` reproduce the registered capture scenes.
