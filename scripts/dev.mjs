import process from "node:process";
import { spawn, spawnSync } from "node:child_process";

const port = process.env.HOMEOS_DEV_PORT?.trim() || "8787";
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
  throw new Error(`HOMEOS_DEV_PORT must be a valid port; received ${JSON.stringify(port)}`);
}

const built = spawnSync("npm", ["run", "build", "--workspace", "@home-os/web"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (built.status !== 0) process.exit(built.status ?? 1);

const migrated = spawnSync(
  "npm",
  [
    "exec",
    "--workspace",
    "@home-os/worker",
    "--",
    "wrangler",
    "d1",
    "migrations",
    "apply",
    "home-os",
    "--local",
  ],
  {
    stdio: ["ignore", "inherit", "inherit"],
    shell: process.platform === "win32",
  },
);
if (migrated.status !== 0) process.exit(migrated.status ?? 1);

const worker = spawn("npm", ["run", "dev", "--workspace", "@home-os/worker", "--", "--port", port], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => worker.kill(signal));
}
worker.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
