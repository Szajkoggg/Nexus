// `nexus help <topic>`: Nexus's standards, shipped with Nexus so every project has the current text after a deploy.
// A project's own conventions stay in its AGENTS.md and in a step's review spec; these texts never name a project.

export const HELP_TOPICS: Record<string, { summary: string; text: string }> = {
  review: {
    summary: "review material: formats, view keys, roles, pairing, rounds, captures, the process",
    text: `nexus help review: the standard for review material

Review material is what the user (or the orchestrator) looks at to accept a step: pictures, sheets, documents, data,
links. Add it with nexus review add before nexus step done. The project's own conventions (which views, which
fixtures, where files go) are in its AGENTS.md and in the step's "review to prepare"; where they say more, they win.

FORMATS (--kind, guessed from the file name when left out)
  image   a picture of one view: PNG for screens (JPEG only for photographs)
  sheet   one picture of many views side by side (a contact sheet); a file name with "sheet" is taken as one
  doc     Markdown, HTML, PDF or text: a report, a table, a write-up
  data    JSON, CSV, YAML, a log
  link    an http(s) URL
  Files stay in the working tree outside version control (for example tmp/review/<step>/), never under .nexus.
  The label (--label) is a caption only: say in a few words what the picture shows.

VIEW KEYS (--key): what a picture shows, so that only like is compared with like
  A key names the view's subject and its state in lowercase words joined by hyphens, then @ and the window's
  width in CSS pixels:
    waiting-tab@492   settings-header-tools@1280   step-sheet-open-question@390   cliff-lit-noon@1920
  Same subject, other state: another key (step-sheet-open-question@390 is not step-sheet-done@390).
  Same view, other width: another key (waiting-tab@390 is not waiting-tab@492).
  Use the same key for the same view everywhere in the step: before, after, every round.

ROLES (--role): what kind of comparison
  before     the old state: the view as it was at the step's base commit
  mockup     the design the new state is meant to follow
  after      the new state; pairs with the before or mockup of its key
  variant-a  one alternative of a view, for the user to choose between
  variant-b  the other alternative; pairs with variant-a of its key
  result     a new view with nothing to compare (a new feature's new screen); stands alone
  --key and --role go together, with exactly one picture file (PNG, JPEG, GIF or WebP) per command.

PAIRING: what is compared with what
  - Only pictures with the same key pair; the label plays no part.
  - An after pairs with the latest before or mockup of its key in the step. Without one, it pairs with the after
    (or result) of its key from the latest earlier round ("round N"). Without that either, it is refused.
  - A variant-b pairs with the latest variant-a of its key; variant-a is added first.
  - The two pictures of a pair have the same pixel size, or the second is refused.
  - Nexus refuses a wrong pair with the reason; nothing is recorded, fix it and add it again.
  - Pictures without a key keep the older rules: --before <path> for one picture, else the same label in an earlier
    round. Use keys for new material.

ROUNDS
  A step sent back runs again as round N (the message that sends it back says which). Add the round's pictures with
  --round N; a keyed picture without --round is recorded in the step's current round. In a later round take the
  afters again with the same keys: they pair with the before or mockup again, or, when there is none, with the
  earlier round's picture of that key. A new screen added as a result in round 1 is added as an after in round 2,
  and is compared with round 1.

CAPTURES: the same conditions on both sides
  - Fixed-viewport captures: the window, not the full page. A full-page capture's height depends on the content, so
    a before and an after would not have the same size.
  - The same window size (width and height), zoom and device scale factor for both pictures of a pair; the width in
    the key is the window's width.
  - The same data and the same state on both sides: the same test project, the same fixture, the same open panel or
    question. A before of another state is not a before.
  - Settled: animations finished, no cursor or hover left over, times that do not drift between the two.

THE PROCESS
  1. Read the step's "review to prepare" and list the views it needs, each with its key.
  2. Before changing anything (or from the step's base commit), take each view's before; or name its mockup.
  3. Do the work. Take each view's after with the same key, window and data.
  4. Add the befores and mockups first, then the afters:
       nexus review add <step> tmp/review/<step>/waiting-tab@492.before.png --key waiting-tab@492 --role before --label "Waiting tab, before"
       nexus review add <step> tmp/review/<step>/waiting-tab@492.png --key waiting-tab@492 --role after --label "Waiting tab with the reasons"
     A new screen: --role result. Two alternatives: --role variant-a, then --role variant-b.
  5. In the step summary say what is compared with what, and which views were taken by hand or left out, and why.

THE CAPTURE TOOL
  Where a project has a capture tool (see its AGENTS.md), use it: the views are data (key, route or scene, window
  size, a few setup actions), the tool takes the afters, and the same list run against the step's base commit takes
  the befores. A tool never blocks a step or a review: a view it cannot take is taken by hand, under the same
  conditions, and the step summary says so. The pair rules apply to both alike.
`,
  },
};

/** `nexus help` without a topic: the commands, then the topics. */
export function topicList(): string {
  return `Topics (nexus help <topic>):\n${Object.entries(HELP_TOPICS).map(([k, t]) => `  ${k.padEnd(10)} ${t.summary}`).join("\n")}\n`;
}
