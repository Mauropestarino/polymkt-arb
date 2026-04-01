import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const [, , ...args] = process.argv;

if (args.length === 0) {
  console.error("Usage: node scripts/pm2-runner.mjs <pm2-args...>");
  process.exit(1);
}

const cwd = process.cwd();
const pm2Home = path.resolve(cwd, ".pm2");
const pm2Binary = process.platform === "win32"
  ? path.resolve(cwd, "node_modules", ".bin", "pm2.cmd")
  : path.resolve(cwd, "node_modules", ".bin", "pm2");

await mkdir(pm2Home, { recursive: true });

const child = spawn(pm2Binary, args, {
  cwd,
  env: {
    ...process.env,
    PM2_HOME: pm2Home,
  },
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
