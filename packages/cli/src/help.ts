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
  nexus review add copies each file into the queue's folder (.nexus/queues/<queue>/review/<step>/), and the item
  names the copy: the dashboard serves it there, and it outlasts the working tree. A link stays a link. Write the
  files anywhere outside the working tree, for example in the system's temporary folder (<temp>/nexus-review/<step>/:
  $TEMP in Git Bash, $env:TEMP in PowerShell), never into the working tree (untracked files there block the cleanup
  of a worktree) and never under .nexus yourself (the command is the writer there). A file whose name is taken by
  another file in that folder is copied as <name>-2, -3, …; the same file added again is not copied twice.
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
       nexus review add <step> <temp>/nexus-review/<step>/waiting-tab@492.before.png --key waiting-tab@492 --role before --label "Waiting tab, before"
       nexus review add <step> <temp>/nexus-review/<step>/waiting-tab@492.png --key waiting-tab@492 --role after --label "Waiting tab with the reasons"
     A new screen: --role result. Two alternatives: --role variant-a, then --role variant-b.
  5. In the step summary say what is compared with what, and which views were taken by hand or left out, and why.

THE CAPTURE TOOL
  Where a project has a capture tool (see its AGENTS.md or README), use it: the views are data (key, route or scene,
  window size, a few setup actions), the tool takes the afters, and the same list run against the step's base commit
  takes the befores. A tool never blocks a step or a review: a view it cannot take is taken by hand, under the same
  conditions, and the step summary says so. The pair rules apply to both alike.
  Nexus's own dashboard has one in the Nexus repository:
    node scripts/capture.ts <views.yaml> --step <queue>/<step>
  The view list (example: scripts/capture/examples/dashboard.yaml):
    seed: scripts/capture/seed-demo.ts          # writes the test projects
    views:
      - key: viewer-before-after@390            # the width comes from the key; height 844, 900 from 1024 wide
        route: "#/demo/UI/UI1"
        label: "The viewer, phone"
        actions:                                # click: <text> | click: {selector}, type: {text, into?},
          - click: { selector: "img[alt='Waiting tab']" }   # press: <key>, wait: <ms>
  It writes the pictures to <temp>/nexus-review/<queue>/<step>/ (--out names another folder; never one in the working
  tree) and prints the nexus review add commands for what it took, befores first, and what it could not take, with why.
`,
  },
  summaries: {
    summary: "the shape of a step summary (nexus step done --summary)",
    text: `nexus help summaries: the shape of a step summary

The summary of nexus step done is what the user reads in review and what the orchestrator's review works from.
Write it in four parts, in this order, each a sentence or a few:
  1. What changed: what the step built or changed, as the user sees it, and where (files, commands, screens).
  2. How it was verified: the checks run and their results, the tests added, the review material and what it shows.
  3. What was left out or differs from the plan: anything of the goal or acceptance not done, done differently, or
     decided on the way, and why. "Nothing" when nothing.
  4. What comes next, if anything: a follow-up the step found, an open question, what the next step should know.
Name the commit with --commit (see nexus help commits). Keep it short: the details are in the commits and the
review material; the summary says what to look at and what to watch for.

Example:
  nexus step done W3 --commit 1a2b3c4 --summary "Changed: a contact graph supports every body; floating ones are
  pinned to their neighbours (Runtime/Core/Rock/Support.cs). Verified: core tests 548 passed; 3 new tests; the
  fixture sheet shows no floating body. Left out: the overhang fixture (it needs W4's bevels). Next: W4 can use
  Support.Graph for its anchors."
`,
  },
  questions: {
    summary: "the shape of a worker's question (nexus ask)",
    text: `nexus help questions: the shape of a question

A question (nexus ask) goes to the orchestrator, which answers what is settled and passes the rest to the user.
Ask so that either can decide in one go. Three parts:
  1. What it blocks: what you cannot do, or would do differently, until it is answered (the step, the part of it).
  2. The options: the ways you see, each with what it means for the work (also with --option <text>, one each).
  3. Your recommendation: which option you would take, and why. Name it with --recommend <option> (its text or its
     number), which must be one of the --option values: the user sees that option's button marked as recommended.
Ask only what the step, the project's rules and its notes do not settle. Without --can-continue, end your turn
after asking: the answer arrives as a message. With --can-continue, go on with work the answer does not touch.

Example:
  nexus ask --step W3 --option "vertical joints only" --option "vertical and inclined" --recommend 1 "Blocks: the canyon joints of
  W3's fixture 4. Options: vertical only (simpler, matches the sketches) or also inclined (truer to the geology,
  two more days). I recommend vertical only, since the sketches show no inclined joints."
`,
  },
  refusals: {
    summary: "what to do when an action is refused",
    text: `nexus help refusals: when an action is refused

Nexus runs every agent with permissions set so that nothing waits for a human prompt: an action outside them is
refused, and Nexus records the refusal for the user to see.
When an action is refused:
  - Do not work around it through another tool or a different command that reaches the same end (for example a
    PowerShell command after a Bash command was refused, or writing a file through the shell after the edit tool
    was refused). The refusal is the user's setting, not an obstacle to get past.
  - You may retry once in a simpler form when the refusal may be about the form (for example a command without
    chaining, cd, && or pipes; one file instead of a glob).
  - Otherwise report what you needed and why: in the step summary, as a question when the step cannot go on without
    it, or with nexus stop when a stop condition says so. The user can allow it for later sessions.
`,
  },
  commits: {
    summary: "a clean working tree at every step's end; the commit nexus step done reports",
    text: `nexus help commits: a clean working tree at every step's end

Every commit belongs to exactly one step: the user keeps or discards a stopped step's commits, and Nexus pushes the
commit an accepted step was reviewed at. So:
  - Commit what the step did before nexus step done, and name it: nexus step done <step> --commit <sha>
    (the last commit, when the step made several).
  - Leave the working tree clean at the step's end, as at a stop: no uncommitted changes to tracked files. What is
    not part of the step (scratch files) stays untracked, outside version control (for example under tmp/), or is
    removed. Review material is written outside the working tree and copied into .nexus by nexus review add
    (nexus help review); in a worktree, untracked files block its cleanup.
  - Commit only the files the step changed, by name; never commit changes you did not make (ask instead).
  - A step that changed nothing commits nothing, and says so in its summary.
  - Before nexus stop: commit what is in a consistent state, with a message that says so; set aside or undo the rest,
    and say in the reason what you left out.
`,
  },
  tests: {
    summary: "running tests while working: only the affected files, stopping at the first failure; the whole suite at the end",
    text: `nexus help tests: running tests while working on a step

While you work, run only the tests that cover what you changed, and stop at the first failure: a run of the whole
suite after a change that breaks many tests takes long and says little. The whole suite runs once, at the step's end,
as the queue's checks (nexus check, with --duration: how long each ran, in seconds, so a check that grows slower
shows), and its result goes into the step summary.
  - The project's own way is in its AGENTS.md or README (a script that runs given files, a watch mode).
  - Nexus's own repository: npm run test:files -- <test file>... [--pattern TEXT] runs the files one after another
    and stops at the first failing test; npm test runs the whole suite; npm run test:times lists how long each file
    took, slowest first.
  - A test that fails only now and then is not run again until it passes: find why (a wait for a state that passes,
    a read before what it reads has landed, a fixed sleep), fix that, or report it with what you found.
`,
  },
};

/** `nexus help` without a topic: the commands, then the topics. */
export function topicList(): string {
  return `Topics (nexus help <topic>):\n${Object.entries(HELP_TOPICS).map(([k, t]) => `  ${k.padEnd(10)} ${t.summary}`).join("\n")}\n`;
}
