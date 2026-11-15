// What the step and the queue panels are given.
import type { ChatEntry } from "@nexus/protocol";
import type { ProjectState, QueueView } from "../../api.ts";

export interface PanelProps {
  project: ProjectState; queue: QueueView; onChanged: () => void; onClose: () => void;
  /** The orchestrator's chat: where its message with a queue's draft is found (the approval's compact list). */
  chat?: readonly ChatEntry[];
  /** Switches a queue waiting for approval to the full view (Approval.tsx). */
  onFull?: () => void;
  /** Where it stands in the waiting list ("2 of 6 waiting"), when it waits for the user (on the phone). */
  of?: string;
}
