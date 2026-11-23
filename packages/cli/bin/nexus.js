#!/usr/bin/env node
// The compile cache first (queue TI2): every agent call starts a process that compiles the CLI and the protocol
// package again; with the cache (in the system's temporary folder, or NODE_COMPILE_CACHE) a call reads them compiled.
// It must be on before main.ts is loaded, so main.ts is imported dynamically. NODE_DISABLE_COMPILE_CACHE turns it off.
import { enableCompileCache } from "node:module";

enableCompileCache();
await import("../src/main.ts");
