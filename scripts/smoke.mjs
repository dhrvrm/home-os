import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webPort = readPort("HOMEOS_SMOKE_WEB_PORT", 13_100);
const webOrigin = `http://127.0.0.1:${webPort}`;
const children = [];
const runAbort = new AbortController();
let stopping = false;
let sessionCookie = "";
let sessionMemberId = "local-owner";

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

async function request(pathname, { method = "GET", body, expectedStatus = 200, expectedVersion, operationId = crypto.randomUUID() } = {}) {
  const response = await fetch(new URL(pathname, webOrigin), {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json", Origin: webOrigin, "X-Operation-ID": operationId,
      ...(expectedVersion ? { "If-Match": String(expectedVersion) } : {}),
      ...(sessionCookie ? { Cookie: sessionCookie, "X-HomeOS-Member": sessionMemberId } : {}) },
    signal: requestSignal(10_000),
  });
  const cookie = response.headers.getSetCookie().filter((value) => value.startsWith("homeos_session=")).at(-1);
  if (cookie) sessionCookie = cookie.split(";")[0];
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
  if (envelope.data.user?.id) sessionMemberId = envelope.data.user.id;
  return envelope.data;
}

function step(message) {
  console.log(`[smoke] ${message}`);
}

async function runJourney() {
  step("anonymous household API access is denied");
  assert.equal((await fetch(`${webOrigin}/api/v1/items`)).status, 401);
  step("first owner setup creates a persisted sign-in");
  await request("/api/v1/auth/setup", {
    method: "POST", expectedStatus: 201,
    body: { name: "Smoke owner", email: "owner@smoke.test", password: "smoke test owner passphrase", setupToken: "smoke-setup-test-key", remember: true },
  });
  const auth = await request("/api/v1/auth/status");
  assert.equal(auth.session.user.id, "local-owner");
  assert.equal(auth.setupRequired, false);
  const manifestResponse = await fetch(`${webOrigin}/manifest.webmanifest`);
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512"));
  assert.equal((await fetch(`${webOrigin}/icons/apple-touch-icon.png`)).status, 200);
  const serviceWorker = await (await fetch(`${webOrigin}/sw.js`)).text();
  assert.ok(serviceWorker.includes("/_next/static/"));
  step("1/9 empty inventory loads through the unified Worker");
  const empty = await request("/api/v1/items");
  assert.deepEqual(empty.items, []);

  step("2/9 exact item can be created");
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

  step("3/9 item location can be edited without changing stock");
  const patched = await request(`/api/v1/items/${encodeURIComponent(item.id)}`, {
    method: "PATCH",
    body: { location: "Kitchen shelf" },
  });
  assert.equal(patched.item.location, "Kitchen shelf");
  assert.equal(patched.item.quantity, 5);

  step("4/9 exact consumption updates quantity");
  const consumed = await request(`/api/v1/items/${encodeURIComponent(item.id)}/events`, {
    method: "POST",
    expectedStatus: 201,
    body: { type: "consume", quantity: 1.5, note: "Smoke test consumption" },
  });
  assert.equal(consumed.item.quantity, 3.5);

  step("5/9 immutable event history records the consumption");
  const history = await request(`/api/v1/items/${encodeURIComponent(item.id)}/events`);
  assert.ok(Array.isArray(history.events));
  assert.equal(history.events.length, 1);
  assert.equal(history.events[0].itemId, item.id);
  assert.equal(history.events[0].type, "consume");
  assert.equal(history.events[0].quantity, 1.5);
  assert.equal(history.events[0].note, "Smoke test consumption");

  step("6/9 archive removes the item from active inventory");
  const archived = await request(`/api/v1/items/${encodeURIComponent(item.id)}`, { method: "DELETE" });
  assert.equal(archived.item.id, item.id);
  assert.equal(typeof archived.item.archivedAt, "string");
  const activeAfterArchive = await request("/api/v1/items");
  assert.deepEqual(activeAfterArchive.items, []);

  step("7/9 archived inventory lists the item explicitly");
  const archivedList = await request("/api/v1/items?archived=only");
  assert.equal(archivedList.items.length, 1);
  assert.equal(archivedList.items[0].id, item.id);

  step("8/9 archived item can be restored");
  const restored = await request(`/api/v1/items/${encodeURIComponent(item.id)}/restore`, { method: "POST" });
  assert.equal(restored.item.id, item.id);
  assert.equal(restored.item.archivedAt, null);

  step("9/9 reload returns the restored persisted projection");
  const reloaded = await request(`/api/v1/items/${encodeURIComponent(item.id)}`);
  assert.equal(reloaded.item.id, item.id);
  assert.equal(reloaded.item.location, "Kitchen shelf");
  assert.equal(reloaded.item.quantity, 3.5);
  assert.equal(reloaded.item.archivedAt, null);
  const activeReload = await request("/api/v1/items");
  assert.deepEqual(activeReload.items.map((entry) => entry.id), [item.id]);
  await runHouseholdJourney(item);
  step("logout revokes the persisted cookie");
  const previousCookie = sessionCookie;
  await request("/api/v1/auth/logout", { method: "POST", body: {} });
  assert.equal((await fetch(`${webOrigin}/api/v1/items`, { headers: { Cookie: previousCookie } })).status, 401);
}

async function runHouseholdJourney(item) {
  step("household: a second owner and recoverable service contact");
  const { member } = await request("/api/v1/members", { method: "POST", expectedStatus: 201,
    body: { name: "Second smoke owner", email: "coowner@smoke.test", password: "second smoke owner passphrase", role: "owner" } });
  assert.equal(member.role, "owner");
  let { contact } = await request("/api/v1/contacts", { method: "POST", expectedStatus: 201,
    body: { name: "Smoke plumber", role: "Plumbing", phone: "+91 98765 43210", address: "Building office", notes: "Fixture contact only" } });
  assert.equal((await request("/api/v1/contacts?search=plumber")).contacts[0].id, contact.id);
  ({ contact } = await request(`/api/v1/contacts/${contact.id}`, { method: "DELETE", expectedVersion: contact.version }));
  assert.ok(contact.archivedAt);
  ({ contact } = await request(`/api/v1/contacts/${contact.id}/restore`, { method: "POST", body: {}, expectedVersion: contact.version }));
  assert.equal(contact.archivedAt, null);

  step("household: recipes use honest inventory hints and stable meal snapshots");
  const recipeInput = { name: "Smoke rice", description: "A fixture dish", servings: 2,
    ingredients: [{ name: "Rice", quantity: 0.5, unit: "kg", inventoryItemId: item.id }], instructions: "Rinse and cook the rice.", labels: ["Dinner"] };
  const operationId = crypto.randomUUID();
  const { recipe } = await request("/api/v1/recipes", { method: "POST", expectedStatus: 201, operationId, body: recipeInput });
  const replay = await request("/api/v1/recipes", { method: "POST", expectedStatus: 201, operationId, body: recipeInput });
  assert.equal(replay.recipe.id, recipe.id);
  assert.equal(recipe.availability.state, "ready");
  const second = (await request("/api/v1/recipes", { method: "POST", expectedStatus: 201,
    body: { name: "Smoke dal", servings: 2, ingredients: [{ name: "Lentils", quantity: 1, unit: "cup" }], instructions: "Simmer the lentils." } })).recipe;
  assert.equal(second.availability.state, "unknown");
  let { meal } = await request("/api/v1/meals", { method: "POST", expectedStatus: 201,
    body: { title: "Smoke dinner", recipeIds: [recipe.id, second.id], cookingAt: new Date(Date.now() + 30 * 60_000).toISOString(), timezone: "Asia/Kolkata", reminderMinutesBefore: 60, notes: "Serve warm" } });
  assert.equal(meal.recipes.length, 2);
  assert.equal(meal.attendance.counts.pending, 2);
  ({ meal } = await request(`/api/v1/meals/${meal.id}/attendance`, { method: "PUT",
    body: { response: "yes", announcementVersion: meal.announcementVersion, expectedResponseVersion: 0 } }));
  assert.equal(meal.attendance.counts.yes, 1);
  const originalAnnouncement = meal.announcementVersion;
  ({ meal } = await request(`/api/v1/meals/${meal.id}`, { method: "PATCH", expectedVersion: meal.version, body: { notes: "Bring your bowl" } }));
  assert.equal(meal.announcementVersion, originalAnnouncement);
  assert.equal(meal.attendance.counts.yes, 1);
  await request(`/api/v1/recipes/${recipe.id}`, { method: "PATCH", expectedVersion: recipe.version, body: { name: "Renamed library rice" } });
  assert.equal((await request(`/api/v1/meals/${meal.id}`)).meal.recipes[0].name, "Smoke rice");
  ({ meal } = await request(`/api/v1/meals/${meal.id}`, { method: "PATCH", expectedVersion: meal.version,
    body: { cookingAt: new Date(Date.now() + 35 * 60_000).toISOString() } }));
  assert.equal(meal.announcementVersion, originalAnnouncement + 1);
  assert.equal(meal.attendance.counts.pending, 2);
  ({ meal } = await request(`/api/v1/meals/${meal.id}/attendance`, { method: "PUT",
    body: { response: "yes", announcementVersion: meal.announcementVersion, expectedResponseVersion: meal.myAttendance.responseVersion } }));

  step("household: scheduled reminders are deduplicated and personal");
  const tick = async () => {
    const result = await fetch(`${webOrigin}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*`, { signal: requestSignal(15_000) });
    assert.equal(result.status, 200, await result.text());
  };
  await tick(); await tick();
  await request("/api/v1/auth/login", { method: "POST", body: { email: "coowner@smoke.test", password: "second smoke owner passphrase", remember: true } });
  assert.equal(sessionMemberId, member.id);
  const inbox = await request("/api/v1/notifications");
  assert.equal(inbox.notifications.length, 1);
  assert.equal(inbox.notifications[0].mealId, meal.id);
  assert.equal(inbox.unreadCount, 1);
  await request(`/api/v1/notifications/${inbox.notifications[0].id}`, { method: "PATCH", body: { read: true } });
  assert.equal((await request("/api/v1/notifications")).unreadCount, 0);
  ({ meal } = await request(`/api/v1/meals/${meal.id}/attendance`, { method: "PUT",
    body: { response: "no", announcementVersion: meal.announcementVersion, expectedResponseVersion: 0 } }));
  assert.equal(meal.attendance.counts.no, 1);
  assert.equal(meal.attendance.counts.yes, 1);
  ({ meal } = await request(`/api/v1/meals/${meal.id}`, { method: "PATCH", expectedVersion: meal.version, body: { status: "cancelled" } }));
  assert.equal(meal.status, "cancelled");
  await tick();
  assert.equal((await request("/api/v1/notifications")).notifications.length, 1);
  await request("/api/v1/notifications/preferences", { method: "PUT", body: { mealReminders: false, pushEnabled: false } });
  assert.equal((await request("/api/v1/items")).items[0].quantity, 3.5);
  step("household: menu, attendance, contacts, inbox, and cancellation persisted");
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
    const config = JSON.parse(await readFile(path.join(rootDir, "apps/worker/wrangler.jsonc"), "utf8"));
    delete config.$schema;
    delete config.routes;
    delete config.workers_dev;
    config.main = path.join(rootDir, "apps/worker/src/index.ts");
    config.assets.directory = path.join(rootDir, "apps/web/out");
    config.vars = { ...config.vars, HOMEOS_SETUP_TOKEN: "smoke-setup-test-key", HOMEOS_PASSWORD_PEPPER: "smoke-pepper-test-key-at-least-thirty-two-characters" };
    const testConfig = path.join(tempDir, "wrangler.json");
    await writeFile(testConfig, JSON.stringify(config));
    const web = startChild("unified Worker", executable("npx"), [
      "wrangler", "dev", "--local", "--config", testConfig,
      "--test-scheduled",
      "--port",
      String(webPort),
      "--persist-to",
      tempDir,
    ], {
      cwd: rootDir,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    });
    await waitFor("unified Worker", `${webOrigin}/readyz`, web);
    step("isolated stack is ready");
    await runJourney();
    step("PASS: authenticated Worker, D1, PWA, inventory, owners, recipes, meals, attendance, contacts, reminders, and logout");
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
