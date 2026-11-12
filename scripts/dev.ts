// Development: the API server (restarting on change) and the dashboard's Vite dev server together.
// It runs apart from the live instance: its own port (4318) and data (%APPDATA%\Nexus-dev, or NEXUS_HOME), so
// editing and restarting never touch the projects the live Nexus serves.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

process.env.NEXUS_PORT ??= "4318";
process.env.NEXUS_HOME ??= join(process.env.APPDATA ?? join(homedir(), ".config"), "Nexus-dev");
console.log(`dev: API on :${process.env.NEXUS_PORT}, data in ${process.env.NEXUS_HOME}, dashboard on http://localhost:5173`);

const procs = [
  spawn(process.execPath, ["--watch", "apps/server/src/main.ts"], { stdio: "inherit" }),
  spawn("npm", ["run", "dev", "-w", "@nexus/web"], { stdio: "inherit", shell: true }),
];
const stop = () => { for (const p of procs) p.kill(); process.exit(); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const p of procs) p.on("exit", stop);
