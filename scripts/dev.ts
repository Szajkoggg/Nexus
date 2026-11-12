// Runs the API server (restarting on change) and the dashboard's Vite dev server together.
import { spawn } from "node:child_process";

const procs = [
  spawn(process.execPath, ["--watch", "apps/server/src/main.ts"], { stdio: "inherit" }),
  spawn("npm", ["run", "dev", "-w", "@nexus/web"], { stdio: "inherit", shell: true }),
];
const stop = () => { for (const p of procs) p.kill(); process.exit(); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const p of procs) p.on("exit", stop);
