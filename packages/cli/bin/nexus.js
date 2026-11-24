#!/usr/bin/env node
// The compile cache first (queue TI2): every agent call starts a process that compiles the CLI and the protocol
// package again; with the cache (in the system's temporary folder, or NODE_COMPILE_CACHE) a call reads them compiled.
// It must be on before main.ts is loaded, so main.ts is imported dynamically. NODE_DISABLE_COMPILE_CACHE turns it off.
// main.ts's run() is the CLI as a function (queue IPR): this file gives it the process's command line, environment,
// working directory and streams, and ends the process with the code it returns.
import { enableCompileCache } from "node:module";
import { readFileSync } from "node:fs";

enableCompileCache();
const { run } = await import("../src/main.ts");
process.exitCode = await run(process.argv.slice(2), {
  env: process.env, cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr,
  stdin: () => readFileSync(0, "utf8"),
});
