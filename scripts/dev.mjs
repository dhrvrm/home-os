import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiPort = readPort("HOMEOS_API_PORT", 8080);
const webPort = readPort("HOMEOS_WEB_PORT", 3100);
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const webOrigins = [`http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`];
const children = [];
let stopping = false;
let stopPromise;

function readPort(name, fallback) {
  const raw = process.env[name]?.trim() || String(fallback);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535; received ${JSON.stringify(raw)}`);
  }
  return port;
}

function preflightPort(name, port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`${name} port ${port} is already in use. Stop that process or set ${name}.`));
        return;
      }
      reject(new Error(`Could not reserve ${name} port ${port}: ${error.message}`));
    });
    server.listen({ host: "0.0.0.0", port, exclusive: true }, () => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
}

function executable(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function startChild(name, command, args, options) {
  const child = spawn(command, args, {
    ...options,
    detached: process.platform !== "win32",
    stdio: "inherit",
  });
  const record = {
    child,
    name,
    exited: new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))),
  };
  children.push(record);

  child.once("error", (error) => {
    if (!stopping) {
      console.error(`[dev] ${name} could not start: ${error.message}`);
      void stopAll("SIGTERM", 1);
    }
  });
  child.once("exit", (code, signal) => {
    if (!stopping) {
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      console.error(`[dev] ${name} stopped unexpectedly (${reason}); stopping the other service.`);
      void stopAll("SIGTERM", code && code > 0 ? code : 1);
    }
  });
  return record;
}

function isRunning(record) {
  return record.child.pid !== undefined && record.child.exitCode === null && record.child.signalCode === null;
}

function signalChild(record, signal) {
  if (!isRunning(record) || record.child.pid === undefined) return;
  try {
    if (process.platform === "win32") record.child.kill(signal);
    else process.kill(-record.child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function stopAll(signal = "SIGTERM", exitCode = 0) {
  if (stopPromise) return stopPromise;
  stopping = true;
  process.exitCode = exitCode;
  stopPromise = (async () => {
    for (const record of children) signalChild(record, signal);
    let timeout;
    await Promise.race([
      Promise.all(children.map((record) => record.exited)),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, 5_000);
      }),
    ]);
    clearTimeout(timeout);
    for (const record of children) signalChild(record, "SIGKILL");
    await Promise.all(children.map((record) => record.exited));
  })();
  return stopPromise;
}

async function waitFor(name, url, record, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (!isRunning(record)) {
      const { code, signal } = await record.exited;
      throw new Error(`${name} exited before becoming ready (${signal ?? `code ${code}`})`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`${name} did not become ready at ${url}: ${lastError?.message ?? "timed out"}`);
}

async function main() {
  if (apiPort === webPort) throw new Error("HOMEOS_API_PORT and HOMEOS_WEB_PORT must be different.");
  await Promise.all([
    preflightPort("HOMEOS_API_PORT", apiPort),
    preflightPort("HOMEOS_WEB_PORT", webPort),
  ]);

  const allowedOrigins = [...new Set([
    ...(process.env.HOMEOS_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    ...webOrigins,
  ])].join(",");
  const api = startChild("API", "go", ["run", "./cmd/server"], {
    cwd: path.join(rootDir, "apps", "api"),
    env: {
      ...process.env,
      HOMEOS_ADDR: `127.0.0.1:${apiPort}`,
      HOMEOS_ALLOWED_ORIGINS: allowedOrigins,
    },
  });
  const web = startChild("web app", executable("npm"), [
    "run",
    "dev",
    "--workspace",
    "@home-os/web",
    "--",
    "--port",
    String(webPort),
  ], {
    cwd: rootDir,
    env: {
      ...process.env,
      HOMEOS_API_PROXY: apiOrigin,
      NEXT_PUBLIC_API_URL: "",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });

  await Promise.all([
    waitFor("API", `${apiOrigin}/readyz`, api),
    waitFor("web app", `http://127.0.0.1:${webPort}/`, web),
  ]);
  console.log(`\nHome OS is ready: http://localhost:${webPort}\nPress Ctrl+C to stop both services.`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    console.log(`\n[dev] received ${signal}; stopping Home OS.`);
    void stopAll(signal, signal === "SIGINT" ? 130 : 143);
  });
}

try {
  await main();
} catch (error) {
  console.error(`[dev] ${error.message}`);
  await stopAll("SIGTERM", 1);
}
