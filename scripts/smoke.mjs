import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webPort = readPort("HOMEOS_SMOKE_WEB_PORT", 13_100);
const webOrigin = `http://127.0.0.1:${webPort}`;
const children = [];
const cookieJar = new Map();
const runAbort = new AbortController();
let stopping = false;

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
        reject(new Error(`${name} port ${port} is already in use. Choose another test port with ${name}.`));
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
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  const capture = (chunk) => {
    output.push(chunk.toString());
    while (output.join("").length > 24_000) output.shift();
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const record = {
    child,
    name,
    output,
    exited: new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))),
  };
  children.push(record);
  child.once("error", (error) => {
    if (!stopping) runAbort.abort(new Error(`${name} could not start: ${error.message}`));
  });
  child.once("exit", (code, signal) => {
    if (!stopping) {
      runAbort.abort(new Error(`${name} stopped unexpectedly (${signal ?? `code ${code}`})`));
    }
  });
  return record;
}

async function runOnce(name, command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) throw new Error(`${name} failed with exit code ${code}:\n${output.slice(-12_000)}`);
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

async function stopChildren(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
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
}

function childDiagnostics() {
  return children
    .map((record) => {
      const text = record.output.join("").trim();
      return text ? `\n--- ${record.name} output ---\n${text}` : "";
    })
    .join("");
}

function requestSignal(timeoutMs) {
  return AbortSignal.any([runAbort.signal, AbortSignal.timeout(timeoutMs)]);
}

async function waitFor(name, url, record, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (runAbort.signal.aborted) throw runAbort.signal.reason;
    if (!isRunning(record)) {
      const { code, signal } = await record.exited;
      throw new Error(`${name} exited before becoming ready (${signal ?? `code ${code}`})`);
    }
    try {
      const response = await fetch(url, { signal: requestSignal(2_000) });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (runAbort.signal.aborted) throw runAbort.signal.reason;
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`${name} did not become ready at ${url}: ${lastError?.message ?? "timed out"}`);
}

async function request(pathname, { method = "GET", body, expectedStatus = 200 } = {}) {
  const headers = new Headers(body === undefined ? undefined : { "Content-Type": "application/json" });
  headers.set("Origin", webOrigin);
  if (cookieJar.size) headers.set("Cookie", cookieValue());
  const response = await fetch(new URL(pathname, webOrigin), {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
    signal: requestSignal(10_000),
  });
  const text = await response.text();
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${pathname} returned non-JSON HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  assert.equal(response.status, expectedStatus, `${method} ${pathname}: ${JSON.stringify(envelope)}`);
  assert.ok(envelope && typeof envelope === "object" && !Array.isArray(envelope), `${method} ${pathname}: envelope must be an object`);
  assert.ok(Object.hasOwn(envelope, "data"), `${method} ${pathname}: envelope is missing data`);
  assert.ok(Object.hasOwn(envelope, "error"), `${method} ${pathname}: envelope is missing error`);
  assert.equal(envelope.error, null, `${method} ${pathname}: ${JSON.stringify(envelope.error)}`);
  assert.notEqual(envelope.data, null, `${method} ${pathname}: envelope data must not be null`);
  return envelope.data;
}

async function rawRequest(pathname, { method = "GET", body, expectedStatus = 200 } = {}) {
  const headers = new Headers(body === undefined ? undefined : { "Content-Type": "application/json" });
  headers.set("Origin", webOrigin);
  if (cookieJar.size) headers.set("Cookie", cookieValue());
  const response = await fetch(new URL(pathname, webOrigin), {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
    redirect: "manual",
    signal: requestSignal(10_000),
  });
  captureCookies(response);
  const text = await response.text();
  assert.equal(response.status, expectedStatus, `${method} ${pathname}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

function captureCookies(response) {
  const values = response.headers.getSetCookie?.() ?? [];
  for (const value of values) {
    const pair = value.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator > 0) cookieJar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

function cookieValue() {
  return [...cookieJar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function step(message) {
  console.log(`[smoke] ${message}`);
}

async function runJourney() {
  step("1/13 unauthenticated inventory is gated");
  const unauthorized = await rawRequest("/api/v1/items", { expectedStatus: 401 });
  assert.equal(unauthorized.data, null);
  assert.equal(unauthorized.error.code, "unauthorized");

  step("2/13 test identity signs in and creates an active home");
  const suffix = crypto.randomUUID();
  await rawRequest("/api/auth/sign-up/email", {
    method: "POST",
    body: { name: "Smoke owner", email: `smoke-${suffix}@example.com`, password: "correct-horse-battery-staple" },
  });
  const organization = await rawRequest("/api/auth/organization/create", {
    method: "POST",
    body: { name: "Smoke home", slug: `smoke-${suffix}` },
  });
  await rawRequest("/api/auth/organization/set-active", {
    method: "POST",
    body: { organizationId: organization.id },
  });
  const session = await request("/api/v1/session");
  assert.equal(session.authenticated, true);
  assert.equal(session.activeOrganization.id, organization.id);
  assert.equal(session.membership.role, "owner");

  step("3/13 MCP OAuth protected-resource discovery is available");
  const discovery = await rawRequest("/.well-known/oauth-protected-resource/mcp");
  assert.equal(discovery.resource, `${webOrigin}/mcp`);
  assert.ok(discovery.scopes_supported.includes("inventory:read"));

  step("4/13 empty inventory loads through the authenticated Worker");
  const empty = await request("/api/v1/items");
  assert.deepEqual(empty.items, []);

  step("5/13 exact item can be created");
  const created = await request("/api/v1/items", {
    method: "POST",
    expectedStatus: 201,
    body: {
      name: "Basmati rice",
      alternativeNames: ["बासमती चावल", "Rice"],
      categories: ["Food", "Staples"],
      location: "Pantry",
      unit: "kg",
      trackingMode: "exact",
      quantity: 5,
      minQuantity: 2,
    },
  });
  const item = created.item;
  assert.equal(typeof item?.id, "string");
  assert.ok(item.id.length > 0);
  assert.equal(item.name, "Basmati rice");
  assert.equal(item.trackingMode, "exact");
  assert.equal(item.quantity, 5);
  assert.deepEqual(item.alternativeNames, ["बासमती चावल", "Rice"]);
  assert.deepEqual(item.categories, ["Food", "Staples"]);

  step("6/13 item location can be edited without changing stock");
  const patched = await request(`/api/v1/items/${encodeURIComponent(item.id)}`, {
    method: "PATCH",
    body: { location: "Kitchen shelf" },
  });
  assert.equal(patched.item.location, "Kitchen shelf");
  assert.equal(patched.item.quantity, 5);

  step("7/13 exact consumption updates quantity");
  const consumed = await request(`/api/v1/items/${encodeURIComponent(item.id)}/events`, {
    method: "POST",
    expectedStatus: 201,
    body: { type: "consume", quantity: 1.5, note: "Smoke test consumption" },
  });
  assert.equal(consumed.item.quantity, 3.5);

  step("8/13 immutable event history records the consumption");
  const history = await request(`/api/v1/items/${encodeURIComponent(item.id)}/events`);
  assert.ok(Array.isArray(history.events));
  assert.equal(history.events.length, 1);
  assert.equal(history.events[0].itemId, item.id);
  assert.equal(history.events[0].type, "consume");
  assert.equal(history.events[0].quantity, 1.5);
  assert.equal(history.events[0].note, "Smoke test consumption");

  step("9/13 archive removes the item from active inventory");
  const archived = await request(`/api/v1/items/${encodeURIComponent(item.id)}`, { method: "DELETE" });
  assert.equal(archived.item.id, item.id);
  assert.equal(typeof archived.item.archivedAt, "string");
  const activeAfterArchive = await request("/api/v1/items");
  assert.deepEqual(activeAfterArchive.items, []);

  step("10/13 archived inventory lists the item explicitly");
  const archivedList = await request("/api/v1/items?archived=only");
  assert.equal(archivedList.items.length, 1);
  assert.equal(archivedList.items[0].id, item.id);

  step("11/13 archived item can be restored");
  const restored = await request(`/api/v1/items/${encodeURIComponent(item.id)}/restore`, { method: "POST" });
  assert.equal(restored.item.id, item.id);
  assert.equal(restored.item.archivedAt, null);

  step("12/13 reload returns the restored persisted projection");
  const reloaded = await request(`/api/v1/items/${encodeURIComponent(item.id)}`);
  assert.equal(reloaded.item.id, item.id);
  assert.equal(reloaded.item.location, "Kitchen shelf");
  assert.equal(reloaded.item.quantity, 3.5);
  assert.equal(reloaded.item.archivedAt, null);
  const activeReload = await request("/api/v1/items");
  assert.deepEqual(activeReload.items.map((entry) => entry.id), [item.id]);

  step("13/13 sign-out revokes API access");
  await rawRequest("/api/auth/sign-out", { method: "POST", body: {} });
  const signedOut = await rawRequest("/api/v1/items", { expectedStatus: 401 });
  assert.equal(signedOut.error.code, "unauthorized");
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "home-os-smoke-"));
  try {
    await preflightPort("HOMEOS_SMOKE_WEB_PORT", webPort);
    step(`building and migrating isolated Worker state (${path.basename(tempDir)})`);
    await runOnce("web build", executable("npm"), ["run", "build", "--workspace", "@home-os/web"], { cwd: rootDir });
    await runOnce("D1 migrations", executable("npx"), [
      "wrangler", "d1", "migrations", "apply", "home-os", "--local",
      "--persist-to", tempDir, "--config", "apps/worker/wrangler.jsonc",
    ], { cwd: rootDir });
    const web = startChild("unified Worker", executable("npx"), [
      "wrangler", "dev", "--local", "--config", "apps/worker/wrangler.jsonc",
      "--port",
      String(webPort),
      "--persist-to",
      tempDir,
      "--var",
      `BETTER_AUTH_URL:${webOrigin}`,
      "--var",
      "BETTER_AUTH_SECRET:smoke-test-secret-at-least-thirty-two-characters",
      "--var",
      "HOMEOS_TEST_AUTH:true",
    ], {
      cwd: rootDir,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    });
    await waitFor("unified Worker", `${webOrigin}/readyz`, web);
    step("isolated stack is ready");
    await runJourney();
    step("PASS: Worker, D1, static PWA, and inventory lifecycle completed");
  } catch (error) {
    const diagnostics = childDiagnostics();
    throw new Error(`${error.message}${diagnostics}`);
  } finally {
    await stopChildren();
    await rm(tempDir, { recursive: true, force: true });
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    runAbort.abort(new Error(`Smoke test interrupted by ${signal}`));
  });
}

try {
  await main();
} catch (error) {
  console.error(`[smoke] FAIL: ${error.message}`);
  process.exitCode = 1;
}
