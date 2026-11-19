// dependency-cruiser for Nexus: the module boundaries AGENTS.md describes, checked by a machine
// (docs/design/checks.md, "Static analysis"). Only boundaries; no style or "good practice" rules.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "protocol-not-to-apps",
      comment: "The protocol is the shared contract: it may not depend on the server, the dashboard or the CLI.",
      severity: "error",
      from: { path: "^packages/protocol/" },
      to: { path: "^(apps/|packages/cli/)" },
    },
    {
      name: "web-not-to-server",
      comment: "The dashboard talks to the server over HTTP only; shared types and logic live in the protocol.",
      severity: "error",
      from: { path: "^apps/web/" },
      to: { path: "^apps/server/" },
    },
    {
      name: "cli-not-to-server",
      comment: "Agents never call the server: the CLI writes files through the protocol, never through server code.",
      severity: "error",
      from: { path: "^packages/cli/" },
      to: { path: "^apps/" },
    },
    {
      name: "not-to-unresolvable",
      comment: "An import that resolves to nothing is a typo or a missing dependency.",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(node_modules|dist)/" },
    // Type-only imports count too: a type pulled from the server into the dashboard is still a dependency on it.
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
