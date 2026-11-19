// ESLint for Nexus: correctness rules only, no style rules (docs/design/checks.md, "Static analysis").
// Every rule here catches a bug a test may miss; formatting and taste are not checked.
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

const typed = [
  "packages/protocol/src/**/*.ts",
  "packages/protocol/test/**/*.ts",
  "packages/cli/src/**/*.ts",
  "packages/cli/test/**/*.ts",
  "apps/server/src/**/*.ts",
  "apps/server/test/**/*.ts",
  "apps/web/src/**/*.{ts,tsx}",
  "apps/web/test/**/*.{ts,tsx}",
];

// Names that hold an id: `id`, `event` (an event's id), `queue`, `step`, `dir`, and anything ending in `Id`.
const ID_NAMES = "/^(id|ids|event|queue|step|dir)$|Id$/";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "tmp/**", ".nexus/**"] },
  {
    files: typed,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      // A promise nobody awaits loses its errors and its ordering: the forgotten `await`.
      // node:test's test() returns a promise the runner itself awaits.
      "@typescript-eslint/no-floating-promises": [
        "error",
        { allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["test", "describe", "it", "suite"] }] },
      ],
      // A promise where a boolean or a void callback is expected: `if (promise)`, an async event handler whose
      // rejection nobody sees.
      "@typescript-eslint/no-misused-promises": "error",
      // A switch over a union must name every member, so a new state (a new run state, a new event) cannot be left
      // unhandled; a `default` does not count as handling the members it hides.
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: false },
      ],
      // An id (a ULID, a queue or step id, a path used as a key) sorted by the locale: in hu-HU "…ZS" sorts after
      // "…ZT", so two events of one millisecond can swap. compareIds (packages/protocol/src/ids.ts) compares by code
      // unit. The rule sees the names below on either side of the call.
      "no-restricted-syntax": [
        "error",
        {
          selector: `CallExpression[callee.property.name='localeCompare']:matches(${["callee.object", "arguments.0"]
            .flatMap((side) => [`[${side}.property.name=${ID_NAMES}]`, `[${side}.name=${ID_NAMES}]`]).join(", ")})`,
          message: "Compare ids with compareIds (@nexus/protocol), not localeCompare: the locale reorders them.",
        },
      ],
    },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}", "apps/web/test/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      // Hooks called conditionally or in a loop break React's state bookkeeping.
      "react-hooks/rules-of-hooks": "error",
      // A missing dependency leaves an effect or a memo working on stale values.
      "react-hooks/exhaustive-deps": "error",
    },
  },
);
