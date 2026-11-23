# Model and effort in an open Ideas conversation (CM1)

Add a collapsed **Model & effort** control below the chat header, between the topic and the messages. It is reachable as soon as the chat opens. Selecting it reveals an inline editor with **Model**, **Effort**, **Use defaults**, **Cancel** and **Save**. Keep the history and composer visible. Replace the existing effort submenu and move model and effort out of the Ideas chat's status line. Keep the turn status and context usage there.

| Chat state | What the user sees |
| --- | --- |
| Empty **Chat about this** | The topic link and empty composer are present. The editor shows the inherited model and effort with their effective values. The user can edit before sending anything. The accepted IC behavior still creates a fresh whole-note chat. A step chat still follows its existing open-or-create path. |
| Idle chat with overrides | The compact summary shows the saved pair. Opening the editor shows the same pair, with an inheritance choice for each field. |
| Reply in progress with a saved change | The compact summary shows **Running** with the current turn's pair and **Next reply** with the saved pair. Label inherited values **Default**. Opening the editor loads the saved pair. A draft edit leaves the running and next-reply summaries as they were. |

## Inheritance and save

- Scope the editor to the open Ideas conversation. Use the existing session fields, conversation PATCH, model catalog, and shared `ModelSelect` and `EffortSelect`. The session's runtime, identity, native history and topic link carry through.
- Resolve each field independently. A session override wins. An absent field follows the effective project Ideas value when the runtimes match, otherwise it follows the session runtime's default. An unset project value also goes to the runtime default. Label the source and show the actual value when known. An unknown runtime default is labeled **Runtime default** until it can be identified.
- Filter effort choices by the effective selected model, even when the model is inherited. Use the catalog's model-specific capability when available. If the default model or its capabilities cannot be established, show the available evidence and an inline explanation. A list of efforts supported by unrelated models does not establish a valid pair.
- Keep the previous effort visible when a model edit makes it incompatible, including when that effort is inherited. Disable Save with a field-level message until the user selects a supported effort or a compatible default. Validate the resolved pair on the server before writing. A failed save keeps the saved pair, editor draft, composer draft and history. Show the error in the editor and allow retry.
- **Use defaults** stages both fields as inherited. Each individual selector also offers inheritance. **Save** sends both fields in one PATCH, with explicit clears for inherited fields, and writes the pair together. **Cancel** discards the editor draft. Keep Save disabled while the request is in flight. On success, collapse the editor and refresh the summary from the saved state. Reopening reads the saved pair.

## Turn boundary

Saving writes the requested pair without starting a turn. At idle it applies on the next reply. While a turn is running, keep the active process and its launch values visible until it finishes. Use the latest successfully saved pair for the next turn, including a follow-up submitted before the active reply ends. A queued follow-up must wait for that boundary. Keep the same native thread and only start a replacement when the old process has finished. Use the same sequencing for work already queued for this chat, preserving the existing compact, stop and handoff behavior.

Today `update` calls `retire` after saving. `AgentHost.retire` closes the working process and immediately removes it from its live lookup, so an immediate `ensure` can open another process before the original finishes. CM2 must close that gap and expose the active and requested pairs independently. Use the active launch/turn facts for the running pair instead of reading the latest session effort as if it were already active.

CM2 verifies the turn boundary and atomic validation with both fake runtimes. CM3 builds the editor and checks the ordinary, step-scoped and IC note-scoped entry points, with saved state, reset, invalid effort and failure regressions.
