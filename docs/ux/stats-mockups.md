# The Stats views: mockups and why each chart has its form

Queue ST3, step ST3.0. The mockups are `mockups/20-stats-global.html` (`?v=a` or `?v=b`: the two forms of the model
comparison) and `mockups/21-stats-project.html` (`?tip=1` shows a point's tooltip); both take `?theme=paper|honey`.
Shared parts: `mockups/stats-mock.css` (the dashboard's tokens) and `mockups/stats-mock.js` (seeded data, the chart
forms, the tooltip, the chart/table toggle). The data is seeded and made up. The forms follow Claude Code's `dataviz`
skill (form first, colour by its job, the validator, thin marks, hover, a table view).

## Where they open

- **Global Stats**: a "Stats · all projects" entry in the left sidebar under the projects; it takes the whole width
  right of the sidebar (no project's rail: it is not a project's page). On the phone a page of its own with a back
  arrow, opened from the project switcher.
- **A project's Stats**: a third tab beside Orchestrator and Ideas in the project's middle column; the rail stays. On
  the phone a fifth tab in the bottom bar.

## The global view

| Part | Form | Why |
|---|---|---|
| Usage windows, per day | Three small multiples: Claude Code 5-hour window as daily columns (highest each day), Claude Code 7-day and Codex weekly as a line with a 10 % wash (level at each day's end); the 90 % pause threshold as a dashed reference line | A peak per day is a discrete magnitude (columns); a window's level over time is a trend (line). Separate panels, not one chart with two series: they are different measures (a day's peak, a running level) and different runtimes, and one series per panel needs no categorical colour |
| Headline | Four stat tiles (steps, accepted in the first round, median working time, ≈ use per step) | Single numbers are tiles, not one-bar charts |
| Model comparison, variant a | One row per model, four aligned columns each with its own scale: bars for the first-round rate (0–100 %) and the estimated use per step; a dot on a 1–2 scale for rounds on average; a median dot with the middle half as a line for working time | The measures have different units, so no shared axis (never two y-scales); aligned rows let the eye read one model across all four. Rounds start at 1, so a dot, not a bar from zero |
| Model comparison, variant b | A scatter: x median working time (with the middle half as a line), y the first-round rate, one directly labelled dot per model; the other measures in a table beside it | The orchestrator's question is a trade-off ("good enough and quick"); a scatter shows it at once. Fewer measures visible as marks, so the table carries the rest |
| Few data (< 5 steps) | The same mark in the de-emphasis grey (a hollow dot) and a "few data" tag | Emphasis, not a new colour: the group is still there but reads as weak |
| Estimates | "≈" before every use figure, "estimated" in the column head, a note under the section | Use per step is apportioned by tokens; it must read as an estimate everywhere it appears |
| Fallback | "↺ n" in the row's name cell and a column in the table | A step that ran on a fallback is marked apart from its model's group |

The filter row (group by model or effort; project; the tag facets kind, activity, area, size, origin) sits above what
it scopes, the models section; the usage windows above it are the whole subscription's and are not narrowed by it.
The range (7, 30, 90 days, all) at the top scopes both.

## The project's Stats tab

Each metric is a card in the form the orchestrator chose (`show` in metrics.yaml), two per row on the desktop and one
under another on the phone:

| `show` | Form | Why |
|---|---|---|
| `line` | A line of the values in step order, a dot per value (each a step), the last value labelled; the target as a dashed secondary-ink line, the warning threshold as a dashed warn line labelled ⚠ | A metric over the steps is a trend; dots because each value is its own step and a link to it. The axis need not start at zero for a line |
| `bar` | Columns, one per value, from zero | A count per step compared by magnitude |
| `number` | A stat tile: the latest value, its change over the range, a 12-point sparkline | One current value |
| (no values) | An empty card that says how a worker records one | A defined metric without values must still show |

A value beyond the threshold is drawn in the warn status colour with ⚠ and its value (never the colour alone). Hover
or focus on a point shows the value first, then the step (queue/step, title), its commit and day, and "Open the step";
a click opens the step. Every card has a Chart/Table toggle; "last … · queue/step →" under each card.

## The colours, validated

One series colour per theme: the theme's accent, stepped into the skill's lightness band where needed. Validated with
the skill's `validate_palette.js` against the cards' surface:

| Theme | Series | Surface | Result |
|---|---|---|---|
| Graphite | `#3f7cf5` (accent-strong; the accent `#5b93ff` is L 0.677, above the dark band) | `#16181d` | all checks pass |
| Paper | `#2f6fec` (accent) | `#ffffff` | all checks pass |
| Honey | `#c47e14` (a new step of the accent's hue; `#f0a93a` and `#e0951f` are above the dark band) | `#1c1915` | all checks pass |

The warn status against the series colour: ΔE 35.2 (Graphite), 30.7 (Paper), 17.8 (Honey) under colour-vision
deficiency, all above the target of 8; the ⚠ mark goes with it anyway. The de-emphasis grey is `fg-3` (contrast
4.8:1, 4.0:1, 4.7:1). Status colours other than warn are not used in the charts.
