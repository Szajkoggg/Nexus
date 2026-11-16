// A short-lived intermediate parent, used only by fake-behaviour's process-ownership scenarios.
import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true, windowsHide: true });
child.unref();
const file = process.argv[2]!;
writeFileSync(`${file}.writing`, JSON.stringify({ root: Number(process.argv[3]), direct: Number(process.argv[4]), orphan: child.pid, bridge: process.pid }));
renameSync(`${file}.writing`, file);
