import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';
import { mkdtemp, readFile, writeFile, mkdir, cp, stat, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { createHash, X509Certificate } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const original = process.env.HOMEOS_UPGRADE_OLD_DEPENDENCIES ? path.resolve(process.env.HOMEOS_UPGRADE_OLD_DEPENDENCIES) : undefined;
const oldRef = '102af58886fc42b531f1aa2a20876ab3ca4c9175', newRef = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
const temporary = await mkdtemp(path.join(os.tmpdir(), 'homeos-old-upgrade-'));
const evidence = path.join(root, 'test-results/pwa-upgrade');
const state = path.join(temporary, 'state'), oldRoot = path.join(temporary, 'old'), newRoot = root;
const node = process.execPath, setupToken = 'upgrade-fixture-setup-code', password = 'upgrade fixture owner passphrase';
let worker, context, logs = '', page, releaseLegacyStatus;
const errors = [];
async function run(command, args, cwd = root) {
    const child = spawn(command, args, {
        cwd, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => output += chunk);
    const code = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
    });
    if (code !== 0) throw Error(`${command} ${args[0]} failed (${code}): ${output.slice(-8000)}`);
    return output;
}

async function freePort() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function stopWorker() {
    if (!worker) return;
    if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill('SIGTERM');
        await Promise.race([
            new Promise(resolve => worker.once('close', resolve)),
            new Promise(resolve => setTimeout(resolve, 5000)),
        ]);
        if (worker.exitCode === null && worker.signalCode === null) {
            worker.kill('SIGKILL');
            await new Promise(resolve => worker.once('close', resolve));
        }
    }
    worker = undefined;
}

async function configure(source, origin) {
    const config = JSON.parse(await readFile(path.join(source, 'apps/worker/wrangler.jsonc'), 'utf8'));
    delete config.$schema;
    delete config.routes;
    delete config.workers_dev;
    config.main = path.join(source, 'apps/worker/src/index.ts');
    config.assets.directory = path.join(source, 'apps/web/out');
    config.d1_databases = config.d1_databases.map(database => ({
        ...database, migrations_dir: path.join(source, 'apps/worker/migrations'),
    }));
    config.vars = {
        ...config.vars,
        HOMEOS_SETUP_TOKEN: setupToken,
        HOMEOS_PASSWORD_PEPPER: 'upgrade-fixture-pepper-at-least-thirty-two-characters',
        HOMEOS_MCP_RESOURCE: origin + '/mcp',
    };
    const configPath = path.join(temporary, 'wrangler-' + crypto.randomUUID() + '.json');
    await writeFile(configPath, JSON.stringify(config));
    await run(node, [
        path.join(source, 'node_modules/wrangler/bin/wrangler.js'),
        'd1', 'migrations', 'apply', 'home-os', '--local', '--persist-to', state, '--config', configPath,
    ], source);
    return configPath;
}

async function startWorker(source, configPath, port, keyPath, certPath) {
    worker = spawn(node, [
        path.join(source, 'node_modules/wrangler/bin/wrangler.js'),
        'dev', '--local', '--config', configPath, '--persist-to', state, '--port', String(port),
        '--local-protocol', 'https', '--https-key-path', keyPath, '--https-cert-path', certPath,
    ], { cwd: source, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [worker.stdout, worker.stderr]) {
        stream.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
    }
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
        if (worker.exitCode !== null || worker.signalCode !== null) throw Error('Worker exited: ' + logs);
        if (/Build failed with|Could not resolve|ERR_MODULE_NOT_FOUND/.test(logs)) {
            throw Error('Worker build failed: ' + logs);
        }
        try {
            const response = await fetch(`https://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(1500) });
            if (response.ok) return;
        } catch { /* The local runtime may still be starting. */ }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw Error('Worker readiness timeout: ' + logs);
}

async function snapshot(ref, destination, deps) {
    await mkdir(destination);
    const archive = path.join(temporary, ref + '.tar');
    await run('git', ['archive', '--format=tar', '--output', archive, ref]);
    await run('tar', ['-xf', archive, '-C', destination]);
    await rm(archive);
    if (!deps) {
        await run('npm', ['ci'], destination);
        return;
    }
    // A physical copy keeps old Turbopack builds inside their own dependency root.
    // On APFS this is copy-on-write; CI installs the old lockfile above instead.
    console.log('[upgrade] cloning old dependencies inside isolated Turbopack root');
    for (const local of ['node_modules', 'apps/web/node_modules', 'apps/worker/node_modules']) {
        const source = path.join(deps, local);
        if (await stat(source).then(() => true, () => false)) {
            await cp(source, path.join(destination, local), {
                recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
            });
        }
    }
}

async function stored() {
    return page.evaluate(async () => {
        const database = await new Promise((resolve, reject) => {
            const request = indexedDB.open('home-os');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        try {
            return await new Promise((resolve, reject) => {
                const transaction = database.transaction(['outbox', 'items'], 'readonly');
                const operations = transaction.objectStore('outbox').getAll();
                const items = transaction.objectStore('items').getAll();
                transaction.oncomplete = () => resolve({ operations: operations.result, items: items.result });
                transaction.onerror = () => reject(transaction.error);
            });
        } finally {
            database.close();
        }
    });
}

try {
    await mkdir(evidence, { recursive: true });
    await snapshot(oldRef, oldRoot, original);
    console.log('[upgrade] building faithful old source in disposable archive');
    await run('npm', ['run', 'build', '--workspace', '@home-os/web'], oldRoot);
    if (process.env.HOMEOS_SKIP_BUILD !== '1')
        await run('npm', ['run', 'build', '--workspace', '@home-os/web']);
    const keyPath = path.join(temporary, 'key.pem'), certPath = path.join(temporary, 'cert.pem');
    assert.equal(spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' }).status, 0);
    const cert = await readFile(certPath, 'utf8');
    if (typeof tls.setDefaultCACertificates !== 'function')
        throw Error('Browser verification requires Node22.23.5 or newer Node22');
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), cert]);
    const spki = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    const port = await freePort(), origin = `https://127.0.0.1:${port}`;
    const oldConfig = await configure(oldRoot, origin);
    await startWorker(oldRoot, oldConfig, port, keyPath, certPath);
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), { channel: process.env.HOMEOS_BROWSER_CHANNEL || (process.platform === 'darwin' ? 'chrome' : 'chromium'), headless: true, viewport: { width: 1365, height: 900 }, args: [`--ignore-certificate-errors-spki-list=${spki}`], serviceWorkers: 'allow' });
    page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(30000);
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + '/?view=inventory');
    await page.getByLabel('Your name', { exact: true }).fill('Upgrade owner');
    await page.getByLabel('Email', { exact: true }).fill('owner@upgrade.test');
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByLabel('Confirm password', { exact: true }).fill(password);
    await page.getByLabel('Home setup code', { exact: true }).fill(setupToken);
    await page.getByRole('button', { name: 'Set up your home', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Add item', exact: true }).filter({ visible: true }).first()).toBeVisible();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    const oldWorker = context.serviceWorkers()[0];
    assert.ok(oldWorker);
    const oldBuild = await oldWorker.evaluate('BUILD.version');
    const oldVersion = await page.evaluate(async () => ({ keys: localStorage.getItem('home-os:session:v1') || sessionStorage.getItem('home-os:session:v1'), caches: await caches.keys() }));
    assert.equal(typeof JSON.parse(oldVersion.keys).expiresAt, 'string');
    await context.setOffline(true);
    const names = ['Offline upgrade rice', 'Offline upgrade salt', 'Offline upgrade oil'];
    for (const name of names) {
        await page.getByRole('button', { name: 'Add item', exact: true }).filter({ visible: true }).first().click();
        await page.getByLabel('Item name', { exact: true }).fill(name);
        await page.getByRole('button', { name: 'Save item', exact: true }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    await expect.poll(async () => (await stored()).operations.length).toBe(3);
    const before = await stored();
    const queued = before.operations.map(operation => ({
        entityId: operation.entityId, operationId: operation.operationId,
        name: before.items.find(item => item.id === operation.entityId)?.name,
    }));
    assert.deepEqual(queued.map(operation => operation.name).sort(), [...names].sort());
    console.log('[upgrade] old installed SW controlled; three stable offline operations queued');
    await page.screenshot({ path: path.join(evidence, 'old-offline.png'), fullPage: true });
    await stopWorker();
    console.log('[upgrade] migrating same D1 to new archive');
    logs = '';
    const newConfig = await configure(newRoot, origin);
    console.log('[upgrade] starting new HTTPS Worker');
    await startWorker(newRoot, newConfig, port, keyPath, certPath);
    console.log('[upgrade] old document reconnects before fresh-document recovery');
    // Let the legacy sync finish before status validation unmounts the old UI.
    // Both are real requests; this selects an ordinary slower-status ordering.
    const legacyStatusGate = new Promise(resolve => { releaseLegacyStatus = resolve; });
    await page.route(origin + '/api/v1/auth/status', async route => {
        await legacyStatusGate;
        await route.continue();
    });
    const legacyStatus = page.waitForResponse(response => response.url() === origin + '/api/v1/auth/status');
    const legacySync = page.waitForResponse(response => response.url() === origin + '/api/v1/sync'
        && response.request().method() === 'POST');
    await context.setOffline(false);
    const refusedLegacySync = await legacySync;
    assert.equal(refusedLegacySync.request().postDataJSON().operations.length, 3);
    assert.equal(refusedLegacySync.status(), 400);
    // The legacy bundle cannot upload this batch or parse the permanent session.
    // Its stored intent survives; the current document resets sending rows too.
    assert.deepEqual((await stored()).operations.map(operation => operation.operationId).sort(),
        queued.map(operation => operation.operationId).sort());
    releaseLegacyStatus();
    assert.equal((await (await legacyStatus).json()).data.session.expiresAt, null);
    await expect(page.getByRole('button', { name: 'Add item', exact: true }).filter({ visible: true })).toHaveCount(0);
    await page.unroute(origin + '/api/v1/auth/status');
    assert.equal(await oldWorker.evaluate('BUILD.version'), oldBuild);
    await page.screenshot({ path: path.join(evidence, 'legacy-reconnect.png'), fullPage: true });
    await page.goto(origin + '/api/app?view=inventory');
    await expect(page.getByRole('button', { name: 'Add item', exact: true }).filter({ visible: true }).first()).toBeVisible();
    await expect.poll(async () => (await stored()).operations.length).toBe(0);
    const after = await stored();
    for (const operation of queued) {
        assert.ok(after.items.some(item => item.id === operation.entityId && item.name === operation.name));
    }
    const savedSnapshot = await page.evaluate(() => JSON.parse(localStorage.getItem('home-os:session:v1') || sessionStorage.getItem('home-os:session:v1')));
    assert.equal(savedSnapshot.expiresAt, null);
    assert.equal(savedSnapshot.user.id, 'local-owner');
    for (const operation of queued) {
        const accepted = await page.evaluate(async ({ entityId }) => {
            const response = await fetch('/api/v1/items/' + encodeURIComponent(entityId) + '/activity');
            return { status: response.status, data: (await response.json()).data };
        }, operation);
        assert.equal(accepted.status, 200);
        const audit = Array.isArray(accepted.data) ? accepted.data : (accepted.data.events ?? accepted.data.items ?? []);
        assert.equal(audit.filter(event => event.operationId === operation.operationId).length, 1);
    }
    await page.screenshot({ path: path.join(evidence, 'fresh-preserved.png'), fullPage: true });
    console.log('[upgrade] old active worker waits for explicit update after pending work settles');
    assert.equal(await oldWorker.evaluate('BUILD.version'), oldBuild);
    await page.evaluate(async () => { const registration = await navigator.serviceWorker.ready; await registration.update(); });
    await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration('/'))?.waiting));
    assert.equal(await oldWorker.evaluate('BUILD.version'), oldBuild);
    const waitingWorkers = context.serviceWorkers().filter(worker => worker !== oldWorker);
    assert.ok(waitingWorkers.length > 0);
    const newBuild = await waitingWorkers[waitingWorkers.length - 1].evaluate('BUILD.version');
    assert.notEqual(newBuild, oldBuild);
    await page.goto(origin + '/api/app?view=account');
    const updateButton = page.getByRole('button', { name: 'Update and reload', exact: true });
    await expect(updateButton).toBeEnabled();
    assert.equal((await stored()).operations.length, 0);
    assert.equal(await oldWorker.evaluate('BUILD.version'), oldBuild);
    await updateButton.click();
    await expect(page.getByRole('heading', { name: 'Connect an assistant', exact: true })).toBeVisible();
    await expect.poll(async () => oldWorker.evaluate('BUILD.version').catch(() => null)).toBe(null);
    await page.goto(origin + '/?view=inventory');
    for (const name of names) await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    await context.setOffline(true);
    await page.reload();
    for (const name of names) await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    assert.equal((await stored()).operations.length, 0);
    await page.screenshot({ path: path.join(evidence, 'updated-offline.png'), fullPage: true });
    assert.deepEqual(errors, []);
    const result = {
        oldRef, newRef,
        checks: [
            'faithful old build+actual old controlled SW',
            'old finite session snapshot and three actual offline queued creates',
            'same local D1+HTTPS origin forward migration',
            'ordinary old-document reconnect refuses oversized batch while preserving every operation ID',
            'fresh /api/app navigation bypasses old SW root cache',
            'permanent null session admitted without clearing same-member queue',
            'all three operationId/entityId pairs accepted exactly once and items retained',
            'old active worker remains while new worker waits',
            'explicit Update and reload only after queue clears activates new build',
            'updated installed shell reopens offline with same owner and item',
        ],
        uncaughtErrors: errors,
    };
    await writeFile(path.join(evidence, 'summary.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
}
catch (error) {
    console.error(error.stack);
    console.error(logs);
    if (page)
        await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => { });
    process.exitCode = 1;
}
finally {
    releaseLegacyStatus?.();
    await context?.close().catch(() => {});
    await stopWorker();
    await rm(temporary, { recursive: true, force: true });
}
