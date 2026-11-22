// What every part of a project's page reads from the page itself rather than through its parents' props: the versions
// its reads are asked at (query.ts) and the reload after one of the user's writes. App.tsx provides it.
import { createContext, useContext } from "react";
import type { Version } from "./query.ts";

export interface Page {
  /** The current project's version: its own reads are asked again when it moves (a change in that project). */
  version: Version;
  /** The version of the current project's reads that change only with its queues (estimates, metrics). */
  queues: Version;
  /** The version of the current project's settings. */
  settings: Version;
  /** The version of one queue's reads (its branch, a step's commits): only that queue's changes move it. */
  queueVersion: (queue: string) => Version;
  /** Moves with every live message: what spans projects (the digest, the usage, the server's state) reads at it. */
  all: Version;
  /** After the user's own write: the project's reads and what spans projects are asked again. */
  reload: () => void;
  /**
   * The same, for a control that stays "in progress" until the page shows its write's outcome (query.ts, Reloads):
   * resolves once the reads asked after the write of these URLs (the ones the control shows; none: all) have landed.
   * Await it inside the action, after the write.
   */
  reloaded: (...urls: string[]) => Promise<void>;
  /** The current project's reader's language (its effective setting, "hu"), if any: what a chat's microphone listens for. */
  reader?: string;
}

const PageContext = createContext<Page>({ version: undefined, queues: undefined, settings: undefined, queueVersion: () => undefined, all: undefined, reload: () => {}, reloaded: () => Promise.resolve() });
export const PageProvider = PageContext.Provider;
export const usePage = (): Page => useContext(PageContext);
