import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";

// Fixture credentials are used only in a newly migrated, disposable local D1.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = path.join(root, "test-results/household");
const owner = {
  name: "Browser owner",
  email: "owner@browser.test",
  password: "browser fixture owner passphrase",
};
const coowner = {
  name: "Second browser owner",
  email: "coowner@browser.test",
  password: "second browser fixture passphrase",
};
const setupToken = "browser-fixture-setup-code";
const channel =
  process.env.HOMEOS_BROWSER_CHANNEL ||
  (process.platform === "darwin" ? "chrome" : "chromium");
const checks = [];
const errors = [];
let worker;
let context;
let otherContext;
let logs = "";
let shuttingDown = false;
const temporary = await mkdtemp(path.join(os.tmpdir(), "home-os-browser-"));

function step(message) {
  console.log(`[household-browser] ${message}`);
}
async function check(name, action) {
  step(name);
  await action();
  checks.push({ name, result: "Pass" });
}
async function run(args, command = process.execPath) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0)
    throw new Error(`${args[0]} exited ${code}:\n${output.slice(-12000)}`);
}
async function availablePort() {
  const supplied = process.env.HOMEOS_BROWSER_PORT;
  if (
    supplied &&
    (!Number.isInteger(Number(supplied)) ||
      Number(supplied) < 1 ||
      Number(supplied) > 65535)
  )
    throw new Error("HOMEOS_BROWSER_PORT must be a valid port");
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(supplied ? Number(supplied) : 0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
async function stop() {
  shuttingDown = true;
  await otherContext?.close();
  await context?.close();
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    worker.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => worker.once("close", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (worker.exitCode === null && worker.signalCode === null) {
      worker.kill("SIGKILL");
      await new Promise((resolve) => worker.once("close", resolve));
    }
  }
  await rm(temporary, { recursive: true, force: true });
}
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    void stop().finally(() => process.exit(1));
  });
function observe(page) {
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
}
function localTime(instant) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
async function api(
  page,
  pathname,
  { method = "GET", body, version, status = 200 } = {},
) {
  const result = await page.evaluate(
    async ({ pathname, method, body, version }) => {
      const auth = await (await fetch("/api/v1/auth/status")).json();
      const response = await fetch(pathname, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-HomeOS-Member": auth.data.session.user.id,
          "X-Operation-ID": crypto.randomUUID(),
          ...(version ? { "If-Match": String(version) } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, envelope: await response.json() };
    },
    { pathname, method, body, version },
  );
  assert.equal(
    result.status,
    status,
    `${method} ${pathname}: ${JSON.stringify(result.envelope.error)}`,
  );
  assert.equal(result.envelope.error, null);
  return result.envelope.data;
}
async function signIn(page, account) {
  await page.getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toHaveCount(0);
}
async function nav(page, name) {
  // Desktop sidebar and mobile nav coexist; use the one currently visible.
  const button = page.getByRole("button", { name, exact: true });
  for (const candidate of await button.all())
    if (await candidate.isVisible()) {
      await candidate.click();
      return;
    }
  const more = page.getByRole("button", { name: "More", exact: true });
  await more.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name, exact: true })
    .click();
}
async function screenshot(page, name) {
  await page.screenshot({
    path: path.join(evidenceDir, `${name}.png`),
    fullPage: true,
  });
}

try {
  await mkdir(evidenceDir, { recursive: true });
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  if (process.env.HOMEOS_SKIP_BUILD !== "1") {
    step("building the current frontend");
    await run(
      ["run", "build", "--workspace", "@home-os/web"],
      process.platform === "win32" ? "npm.cmd" : "npm",
    );
  }
  const config = JSON.parse(
    await readFile(path.join(root, "apps/worker/wrangler.jsonc"), "utf8"),
  );
  delete config.$schema;
  delete config.routes;
  delete config.workers_dev;
  config.main = path.join(root, "apps/worker/src/index.ts");
  config.assets.directory = path.join(root, "apps/web/out");
  config.d1_databases = config.d1_databases.map((database) => ({
    ...database,
    migrations_dir: path.join(root, "apps/worker/migrations"),
  }));
  config.vars = {
    ...config.vars,
    HOMEOS_SETUP_TOKEN: setupToken,
    HOMEOS_PASSWORD_PEPPER:
      "browser-fixture-pepper-at-least-thirty-two-characters",
  };
  const configPath = path.join(temporary, "wrangler.json");
  await writeFile(configPath, JSON.stringify(config));
  const wrangler = "node_modules/wrangler/bin/wrangler.js";
  await run([
    wrangler,
    "d1",
    "migrations",
    "apply",
    "home-os",
    "--local",
    "--persist-to",
    temporary,
    "--config",
    configPath,
  ]);
  worker = spawn(
    process.execPath,
    [
      wrangler,
      "dev",
      "--local",
      "--config",
      configPath,
      "--persist-to",
      temporary,
      "--port",
      String(port),
      "--test-scheduled",
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  const capture = (chunk) => {
    logs = (logs + chunk).slice(-16000);
  };
  worker.stdout.on("data", capture);
  worker.stderr.on("data", capture);
  worker.on("error", (error) => {
    if (!shuttingDown) errors.push(error.message);
  });
  await expect
    .poll(
      async () => {
        if (worker.exitCode !== null)
          throw new Error(`Worker stopped: ${logs}`);
        try {
          return (
            await fetch(`${origin}/readyz`, {
              signal: AbortSignal.timeout(1000),
            })
          ).status;
        } catch {
          return 0;
        }
      },
      { timeout: 60000 },
    )
    .toBe(200);
  context = await chromium.launchPersistentContext(
    path.join(temporary, "chrome-profile"),
    {
      channel,
      headless: true,
      viewport: { width: 1365, height: 900 },
      serviceWorkers: "allow",
    },
  );
  const page = context.pages()[0] || (await context.newPage());
  observe(page);
  await page.goto(`${origin}/?view=menu`);
  await check("first owner setup and preserved menu destination", async () => {
    await page.getByLabel("Your name", { exact: true }).fill(owner.name);
    await page.getByLabel("Email", { exact: true }).fill(owner.email);
    await page.getByLabel("Password", { exact: true }).fill(owner.password);
    await page
      .getByLabel("Confirm password", { exact: true })
      .fill(owner.password);
    await page.getByLabel("Home setup code", { exact: true }).fill(setupToken);
    await page
      .getByRole("button", { name: "Set up your home", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Cooking agenda", exact: true }),
    ).toBeVisible();
    assert.equal(new URL(page.url()).searchParams.get("view"), "menu");
  });
  await api(page, "/api/v1/members", {
    method: "POST",
    status: 201,
    body: { ...coowner, role: "owner" },
  });
  let meal;
  await check(
    "empty menu creates a recipe inline without losing the meal draft",
    async () => {
      await page
        .getByRole("button", { name: "Schedule meal", exact: true })
        .click();
      let dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("Meal title", { exact: true })
        .fill("Browser dinner");
      await dialog
        .getByLabel("Cooking date and time", { exact: false })
        .fill(localTime(new Date(Date.now() + 45 * 60000)));
      await dialog
        .getByRole("button", {
          name: "Add a recipe for this meal",
          exact: true,
        })
        .click();
      dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("Recipe name", { exact: true })
        .fill("Browser rice");
      await dialog
        .getByLabel("Ingredient 1 name", { exact: true })
        .fill("Rice");
      await dialog
        .getByLabel("Ingredient 1 quantity", { exact: true })
        .fill("1");
      await dialog.getByLabel("Ingredient 1 unit", { exact: true }).fill("cup");
      await dialog
        .getByLabel("Cooking instructions", { exact: true })
        .fill("Rinse and cook.");
      await dialog
        .getByRole("button", { name: "Save recipe", exact: true })
        .click();
      await expect(
        dialog.getByLabel("Meal title", { exact: true }),
      ).toHaveValue("Browser dinner");
      await expect(
        dialog.getByRole("checkbox", { name: "Browser rice", exact: true }),
      ).toBeChecked();
      const { recipe } = await api(page, "/api/v1/recipes", {
        method: "POST",
        status: 201,
        body: {
          name: "Browser dal",
          servings: 4,
          instructions: "Simmer lentils.",
          ingredients: [{ name: "Lentils", quantity: 1, unit: "cup" }],
        },
      });
      // Reopen the same saved draft after creating the second reusable dish through the API.
      await dialog
        .getByRole("button", { name: "Save meal", exact: true })
        .click();
      await expect(
        page.getByRole("article", { name: "Browser dinner", exact: true }),
      ).toBeVisible();
      const from = localTime(new Date()).slice(0, 10);
      const to = localTime(new Date(Date.now() + 7 * 86400000)).slice(0, 10);
      const listed = await api(page, `/api/v1/meals?from=${from}&to=${to}`);
      meal = listed.meals.find((entry) => entry.title === "Browser dinner");
      assert.ok(meal);
      meal = (
        await api(page, `/api/v1/meals/${meal.id}`, {
          method: "PATCH",
          version: meal.version,
          body: { recipeIds: [meal.recipes[0].sourceRecipeId, recipe.id] },
        })
      ).meal;
      await page.reload();
      const entry = page.getByRole("article", {
        name: "Browser dinner",
        exact: true,
      });
      await expect(
        entry.getByText("Browser rice", { exact: true }),
      ).toBeVisible();
      await expect(
        entry.getByText("Browser dal", { exact: true }),
      ).toBeVisible();
    },
  );
  await check(
    "two owners answer and a changed cooking time requests reconfirmation",
    async () => {
      const entry = page.getByRole("article", {
        name: "Browser dinner",
        exact: true,
      });
      await entry
        .getByRole("button", { name: "I’m eating", exact: true })
        .click();
      await expect(
        entry.getByText("Your answer:", { exact: false }),
      ).toContainText("Eating");
      otherContext = await context
        .browser()
        .newContext({ viewport: { width: 1365, height: 900 } });
      const other = await otherContext.newPage();
      observe(other);
      await other.goto(`${origin}/?view=menu&meal=${meal.id}`);
      await signIn(other, coowner);
      await expect(
        other.getByRole("region", { name: "Opened meal", exact: true }),
      ).toBeVisible();
      await other
        .getByRole("region", { name: "Opened meal", exact: true })
        .getByRole("button", { name: "Not eating", exact: true })
        .click();
      meal = (await api(page, `/api/v1/meals/${meal.id}`)).meal;
      assert.equal(meal.attendance.counts.yes, 1);
      assert.equal(meal.attendance.counts.no, 1);
      await entry
        .getByRole("button", { name: "Edit meal", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("Cooking date and time", { exact: false })
        .fill(localTime(new Date(Date.now() + 50 * 60000)));
      await expect(
        dialog.getByText(
          "Changing the time or dishes asks everyone to confirm again.",
        ),
      ).toBeVisible();
      await dialog
        .getByRole("button", { name: "Save meal", exact: true })
        .click();
      await expect(
        entry.getByText(
          "The time or dishes changed. Please confirm your answer again.",
        ),
      ).toBeVisible();
      await expect(
        entry.getByText("You’re marked as eating.", { exact: true }),
      ).toHaveCount(0);
      meal = (await api(page, `/api/v1/meals/${meal.id}`)).meal;
      assert.equal(meal.attendance.counts.pending, 2);
      await other.reload();
      await expect(
        other
          .getByRole("region", { name: "Opened meal", exact: true })
          .getByText(
            "The time or dishes changed. Please confirm your answer again.",
          ),
      ).toBeVisible();
      await screenshot(page, "desktop-menu");
    },
  );
  await check(
    "contacts save, safe call links, archive and restore",
    async () => {
      await nav(page, "Contacts");
      await page
        .getByRole("button", { name: "Add contact", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("Contact name", { exact: true })
        .fill("Browser plumber");
      await dialog
        .getByLabel("Relationship / service", { exact: true })
        .fill("Plumbing");
      await dialog.getByLabel("Phone", { exact: true }).fill("+91 98765 43210");
      await dialog
        .getByLabel("Address", { exact: true })
        .fill("Building office");
      await dialog
        .getByRole("button", { name: "Save contact", exact: true })
        .click();
      let entry = page.getByRole("article", {
        name: "Browser plumber",
        exact: true,
      });
      await expect(
        entry.getByRole("link", { name: "Call Browser plumber", exact: true }),
      ).toHaveAttribute("href", "tel:+919876543210");
      await entry
        .getByRole("button", { name: "Archive contact", exact: true })
        .click();
      await expect(entry).toHaveCount(0);
      await page
        .getByRole("combobox", { name: /Contact status/ })
        .selectOption("archived");
      entry = page.getByRole("article", {
        name: "Browser plumber",
        exact: true,
      });
      await entry
        .getByRole("button", { name: "Restore contact", exact: true })
        .click();
      await page
        .getByRole("combobox", { name: /Contact status/ })
        .selectOption("active");
      await expect(entry).toBeVisible();
    },
  );
  await check(
    "scheduled reminders appear once in the personal inbox",
    async () => {
      const tick = async () =>
        assert.equal(
          (await fetch(`${origin}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*`))
            .status,
          200,
        );
      await tick();
      await tick();
      await nav(page, "Notifications");
      const inbox = await api(page, "/api/v1/notifications");
      assert.equal(inbox.notifications.length, 1);
      await expect(
        page.getByText(inbox.notifications[0].title, { exact: true }),
      ).toBeVisible();
      await screenshot(page, "desktop-notifications");
    },
  );
  await check(
    "service worker push hides private detail without a device grant and sanitizes clicks",
    async () => {
      await context.grantPermissions(["notifications"], { origin });
      const inbox = await api(page, "/api/v1/notifications");
      const notification = inbox.notifications[0];
      const session = await api(page, "/api/v1/auth/status");
      const cdp = await context.newCDPSession(page);
      const registrations = [];
      cdp.on("ServiceWorker.workerRegistrationUpdated", (event) =>
        registrations.push(...event.registrations),
      );
      await cdp.send("ServiceWorker.enable");
      await expect
        .poll(() =>
          registrations.some((item) => item.scopeURL === `${origin}/`),
        )
        .toBe(true);
      const registration = registrations.find(
        (item) => item.scopeURL === `${origin}/`,
      );
      await cdp.send("ServiceWorker.deliverPushMessage", {
        origin,
        registrationId: registration.registrationId,
        data: JSON.stringify({
          notificationId: notification.id,
          memberId: session.session.user.id,
          mealId: meal.id,
          url: "https://untrusted.invalid/steal",
        }),
      });
      await expect
        .poll(() =>
          page.evaluate(async () =>
            (
              await (await navigator.serviceWorker.ready).getNotifications()
            ).map((item) => item.title),
          ),
        )
        .toContain("Home OS");
      const serviceWorker = context.serviceWorkers()[0];
      // The native push event above is delivered by Chrome. For click dispatch, capture
      // openWindow rather than depending on an OS notification tray/user activation.
      const destination = await serviceWorker.evaluate(async () => {
        const notifications = await self.registration.getNotifications();
        const opened = [];
        const original = self.clients.openWindow;
        self.clients.openWindow = async (url) => {
          opened.push(url);
          return null;
        };
        try {
          const event = new NotificationEvent("notificationclick", {
            notification: notifications[0],
          });
          const pending = [];
          Object.defineProperty(event, "waitUntil", {
            value: (promise) => pending.push(promise),
          });
          self.dispatchEvent(event);
          await Promise.all(pending);
          return opened[0];
        } finally {
          self.clients.openWindow = original;
        }
      });
      assert.equal(destination, `${origin}/?view=notifications`);
      await cdp.detach();
    },
  );
  await check(
    "PWA is controlled, has a valid install manifest and caches offline reads",
    async () => {
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
      });
      await page.reload();
      await expect
        .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
        .toBe(true);
      const cdp = await context.newCDPSession(page);
      const installability = await cdp.send("Page.getInstallabilityErrors");
      assert.deepEqual(installability.installabilityErrors, []);
      const manifest = await cdp.send("Page.getAppManifest");
      assert.deepEqual(manifest.errors, []);
      await cdp.detach();
      await otherContext.close();
      otherContext = undefined;
      await nav(page, "Contacts");
      await expect(
        page.getByRole("article", { name: "Browser plumber", exact: true }),
      ).toBeVisible();
      await context.setOffline(true);
      await expect
        .poll(() => page.evaluate(() => navigator.onLine))
        .toBe(false);
      await page.reload();
      await expect
        .poll(() => page.evaluate(() => navigator.onLine))
        .toBe(false);
      await expect(
        page.getByRole("article", { name: "Browser plumber", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Add contact", exact: true }),
      ).toBeDisabled();
      await screenshot(page, "offline-contacts");
      await context.setOffline(false);
      await page.reload();
    },
  );
  await check(
    "mobile navigation and household views fit 390px and 320px",
    async () => {
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        for (const destination of [
          "Menu",
          "Recipes",
          "Contacts",
          "Notifications",
          "Members",
          "Account",
        ]) {
          await nav(page, destination);
          const content = {
            Menu: page.getByRole("article", {
              name: "Browser dinner",
              exact: true,
            }),
            Recipes: page.getByRole("article", {
              name: "Browser rice",
              exact: true,
            }),
            Contacts: page.getByRole("article", {
              name: "Browser plumber",
              exact: true,
            }),
            Notifications: page.getByRole("article", {
              name: "Will you be joining this meal?",
              exact: true,
            }),
            Members: page.getByRole("article", {
              name: owner.name,
              exact: true,
            }),
            Account: page.getByRole("button", {
              name: "Sign out",
              exact: true,
            }),
          }[destination];
          await expect(content).toBeVisible();
          await expect
            .poll(() =>
              page.evaluate(
                () => document.documentElement.scrollWidth <= window.innerWidth,
              ),
            )
            .toBe(true);
        }
        await nav(page, "Menu");
        await expect(
          page.getByRole("article", { name: "Browser dinner", exact: true }),
        ).toBeVisible();
        await screenshot(page, `mobile-menu-${width}`);
      }
    },
  );
  await check(
    "sign out clears local household data and a meal deep link survives sign in",
    async () => {
      await nav(page, "Account");
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Sign in", exact: true }),
      ).toBeVisible();
      const remaining = await page.evaluate(async () => {
        const database = await new Promise((resolve, reject) => {
          const request = indexedDB.open("home-os");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          const stores = Array.from(database.objectStoreNames);
          const transaction = database.transaction(stores, "readonly");
          return await Promise.all(
            stores.map(
              (name) =>
                new Promise((resolve, reject) => {
                  const request = transaction.objectStore(name).count();
                  request.onsuccess = () => resolve(request.result);
                  request.onerror = () => reject(request.error);
                }),
            ),
          );
        } finally {
          database.close();
        }
      });
      assert.ok(
        remaining.every((count) => count === 0),
        "Sign-out must clear every household table",
      );
      await page.goto(`${origin}/?view=menu&meal=${meal.id}`);
      await signIn(page, owner);
      await expect(
        page.getByRole("region", { name: "Opened meal", exact: true }),
      ).toBeVisible();
      assert.equal(new URL(page.url()).searchParams.get("meal"), meal.id);
      await nav(page, "Contacts");
      await page.goBack();
      await expect(
        page.getByRole("region", { name: "Opened meal", exact: true }),
      ).toBeVisible();
    },
  );
  assert.deepEqual(errors, [], "Uncaught browser errors");
  await writeFile(
    path.join(evidenceDir, "summary.json"),
    JSON.stringify(
      {
        driver: `Playwright/Chromium (${channel})`,
        checks,
        uncaughtErrors: errors,
        physicalPushDelivery:
          "Not exercised: requires a real user's installed device and consent.",
      },
      null,
      2,
    ),
  );
  step(
    `PASS: ${checks.length} browser journeys; credential-free screenshots and summary in test-results/household`,
  );
} catch (error) {
  await writeFile(
    path.join(evidenceDir, "summary.json"),
    JSON.stringify(
      { checks, failure: error.message, uncaughtErrors: errors },
      null,
      2,
    ),
  );
  console.error(`[household-browser] FAIL: ${error.stack}\n${logs}`);
  process.exitCode = 1;
} finally {
  await stop();
}
