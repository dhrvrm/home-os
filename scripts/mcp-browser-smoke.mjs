import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { createHash, X509Certificate } from 'node:crypto';
import { createServer as createCallbackServer } from 'node:http';
import { Client, StreamableHTTPClientTransport, auth } from '@modelcontextprotocol/client';
import { chromium, expect } from '@playwright/test';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const newRef = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
const temporary = await mkdtemp(path.join(os.tmpdir(), 'homeos-mcp-ui-'));
const evidence = path.join(root, 'test-results/mcp-browser');
const state = path.join(temporary, 'state');
const node = process.execPath, setupToken = 'upgrade-fixture-setup-code', password = 'upgrade fixture owner passphrase';
let worker, context, logs = '', page;
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

let callbackServer, client, transport, releaseRenewal;
try {
    await mkdir(evidence, { recursive: true });
    if (process.env.HOMEOS_SKIP_BUILD !== '1')
        await run('npm', ['run', 'build', '--workspace', '@home-os/web']);
    const keyPath = path.join(temporary, 'key.pem'), certPath = path.join(temporary, 'cert.pem');
    assert.equal(spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' }).status, 0);
    const cert = await readFile(certPath, 'utf8');
    if (typeof tls.setDefaultCACertificates !== 'function')
        throw Error('Browser verification requires Node22.23.5 or newer Node22');
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), cert]);
    const spki = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    const port = await freePort(), origin = `https://127.0.0.1:${port}`, resource = origin + '/mcp';
    const config = await configure(root, origin);
    await startWorker(root, config, port, keyPath, certPath);
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), { channel: process.env.HOMEOS_BROWSER_CHANNEL || (process.platform === 'darwin' ? 'chrome' : 'chromium'), headless: true, viewport: { width: 1365, height: 900 }, args: [`--ignore-certificate-errors-spki-list=${spki}`], serviceWorkers: 'allow' });
    page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(30000);
    page.on('pageerror', e => errors.push(e.message));
    let finishCallback;
    const callback = new Promise(resolve => finishCallback = resolve);
    callbackServer = createCallbackServer((request, response) => {
        response.writeHead(200, {
            'Content-Type': 'text/html', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        });
        response.end('<!doctype html><title>Assistant callback</title><p>Return to your assistant.</p>');
        finishCallback(new URL(request.url, `http://127.0.0.1:${callbackServer.address().port}`));
    });
    await new Promise(resolve => callbackServer.listen(0, '127.0.0.1', resolve));
    const callbackUrl = `http://127.0.0.1:${callbackServer.address().port}/callback`, expectedState = crypto.randomUUID();
    let information, tokens, verifier, discovery, redirects = 0, saves = 0;
    const provider = {
        redirectUrl: callbackUrl,
        clientMetadata: {
            client_name: 'Browser MCP verifier', redirect_uris: [callbackUrl],
            token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
        },
        state: () => expectedState,
        clientInformation: () => information,
        saveClientInformation: value => { information = value; },
        tokens: () => tokens,
        saveTokens: value => { tokens = value; saves++; },
        saveCodeVerifier: value => { verifier = value; },
        codeVerifier: () => verifier,
        saveDiscoveryState: value => { discovery = value; },
        discoveryState: () => discovery,
        redirectToAuthorization: async url => { redirects++; await page.goto(url.href); },
    };
    console.log('[mcp-ui] actual SDK discovery/DCR/PKCE -> fresh browser setup/consent');
    assert.equal(await auth(provider, { serverUrl: resource, scope: 'home:access' }), 'REDIRECT');
    await page.getByLabel('Your name', { exact: true }).fill('MCP browser owner');
    await page.getByLabel('Email', { exact: true }).fill('owner@upgrade.test');
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByLabel('Confirm password', { exact: true }).fill(password);
    await page.getByLabel('Home setup code', { exact: true }).fill(setupToken);
    await page.getByRole('button', { name: 'Set up your home', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Review access to your home', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Browser MCP verifier', exact: true })).toBeVisible();
    await expect(page.getByText(/Any local process may be listening/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeEnabled();
    await page.screenshot({ path: path.join(evidence, 'consent-desktop.png'), fullPage: true });
    for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: path.join(evidence, `consent-${width}.png`), fullPage: true });
    }
    await page.getByRole('button', { name: 'Allow', exact: true }).click();
    const returned = await Promise.race([callback, new Promise((_, reject) => setTimeout(() => reject(Error('No client callback')), 15000))]);
    assert.equal(returned.searchParams.get('state'), expectedState);
    assert.equal(returned.searchParams.get('iss'), origin);
    assert.ok(returned.searchParams.get('code'));
    assert.equal(await auth(provider, { serverUrl: resource, authorizationCode: returned.searchParams.get('code'), iss: returned.searchParams.get('iss') }), 'AUTHORIZED');
    assert.equal(tokens.expires_in, 900);
    transport = new StreamableHTTPClientTransport(new URL(resource), { authProvider: provider });
    client = new Client({ name: 'home-os-browser-proof', version: '1.0.0' });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.filter(tool => !tool.name.startsWith('ledger_')).length, 50);
    assert.equal(tools.tools.filter(tool => tool.name.startsWith('ledger_')).length, 19);
    const call = async (name, arguments_ = {}) => {
        const result = await client.callTool({ name, arguments: arguments_ });
        assert.notEqual(result.isError, true, name + ': ' + JSON.stringify(result.structuredContent));
        return result.structuredContent;
    };
    const home = await call('home_context');
    assert.equal(home.member.role, 'owner');
    const operationId = crypto.randomUUID(), itemId = 'mcp-browser-rice';
    const created = await client.callTool({ name: 'inventory_create', arguments: { operationId, id: itemId, name: 'MCP browser rice', trackingMode: 'exact', quantity: 3, minQuantity: 1, unit: 'kg', categories: ['Groceries'] } });
    assert.notEqual(created.isError, true);
    assert.equal(created.structuredContent.item.quantity, 3);
    const stocked = await client.callTool({ name: 'inventory_stock', arguments: { operationId: crypto.randomUUID(), itemId, expectedVersion: 1, type: 'consume', quantity: 1 } });
    assert.notEqual(stocked.isError, true);
    assert.equal(stocked.structuredContent.item.quantity, 2);
    await page.setViewportSize({ width: 1365, height: 900 });
    await page.goto(origin + '/?view=account');
    await expect(page.getByRole('heading', { name: 'Connect an assistant', exact: true })).toBeVisible();
    await expect(page.getByText('Authorized', { exact: true })).toBeVisible();
    const current = await page.evaluate(async () => { const response = await fetch('/api/v1/auth/status'); return (await response.json()).data.session; });
    assert.equal(current.expiresAt, null);
    assert.match(current.sessionId, /^[a-f0-9]{32}$/);
    const item = await page.evaluate(async (id) => (await (await fetch('/api/v1/items/' + id)).json()).data.item, itemId);
    assert.equal(item.quantity, 2);
    const http = (route) => page.evaluate(async (route) => {
        const response = await fetch('/api/v1' + route);
        const body = await response.json();
        return { status: response.status, data: body.data, error: body.error };
    }, route);
    console.log('[mcp-ui] commands in every domain and HTTP truth parity');
    const rule = (await call('expenses_create', {
        operationId: crypto.randomUUID(), name: 'MCP water', amountMinor: 24000,
        currency: 'INR', cadence: { unit: 'month', interval: 1, anchorDate: home.localDate },
        participants: [{ memberId: home.member.id }],
    })).rule;
    assert.equal((await http('/expenses/' + rule.id)).data.rule.amountMinor, 24000);
    const recipe = (await call('recipes_create', {
        operationId: crypto.randomUUID(), name: 'MCP rice bowl', servings: 2,
        ingredients: [{ name: 'Rice', inventoryItemId: itemId, quantity: 1, unit: 'kg' }],
        instructions: 'Wash and simmer.',
    })).recipe;
    assert.equal((await http('/recipes/' + recipe.id)).data.recipe.name, recipe.name);
    const tomorrow = new Date(home.localDate + 'T00:00:00Z');
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const cookingDate = tomorrow.toISOString().slice(0, 10);
    const meal = (await call('meals_create', {
        operationId: crypto.randomUUID(), title: 'MCP tomorrow dinner', recipeIds: [recipe.id],
        cookingAt: cookingDate + 'T19:00', timezone: home.timezone,
    })).meal;
    const answered = (await call('meal_attendance_set', {
        operationId: crypto.randomUUID(), mealId: meal.id, response: 'yes',
        announcementVersion: meal.announcementVersion,
        expectedResponseVersion: meal.myAttendance.responseVersion,
    })).meal;
    assert.equal(answered.myAttendance.response, 'yes');
    assert.equal((await http('/meals/' + meal.id)).data.meal.myAttendance.response, 'yes');
    const contact = (await call('contacts_create', {
        operationId: crypto.randomUUID(), name: 'MCP plumber', role: 'Repairs', phone: '+91123456789',
    })).contact;
    assert.equal((await http('/contacts/' + contact.id)).data.contact.name, contact.name);
    const preferences = await call('notification_preferences_set', {
        operationId: crypto.randomUUID(), mealReminders: true, pushEnabled: false,
    });
    assert.deepEqual((await http('/notifications/preferences')).data.preferences, preferences.preferences);
    assert.ok(Array.isArray((await call('notifications_list')).notifications));
    assert.ok((await call('members_list')).members.some(member => member.id === home.member.id));
    const revised = await call('members_update', {
        operationId: crypto.randomUUID(), memberId: home.member.id, name: 'MCP browser owner',
    });
    assert.equal(revised.member.name, 'MCP browser owner');
    assert.ok((await http('/members')).data.members.some(member => member.id === home.member.id));
    assert.ok((await call('sessions_list')).sessions.some(session => session.id === current.sessionId));
    assert.ok((await call('connections_list')).connections.some(connection => connection.id === home.currentConnectionId));
    const activity = (await http('/activity?limit=50')).data;
    assert.ok((activity.events ?? activity.items ?? activity).some(event => event.operationId === operationId));
    const handoff = await call('notification_device_setup');
    assert.equal(handoff.status, 'requires_user_action');
    assert.equal(handoff.destination, origin + '/?view=notifications&action=enable');
    assert.equal(await page.evaluate(() => Notification.permission), 'default');
    assert.equal((await http('/items/' + itemId)).data.item.quantity, 2);
    await page.screenshot({ path: path.join(evidence, 'account-desktop.png'), fullPage: true });
    for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: path.join(evidence, `account-${width}.png`), fullPage: true });
    }
    console.log('[mcp-ui] silent SDK refresh and accepted-only Account revocation');
    assert.equal(await auth(provider, { serverUrl: resource }), 'AUTHORIZED');
    assert.equal(redirects, 1);
    assert.ok(saves >= 2);
    console.log('[mcp-ui] browser sign-out does not end independent MCP access');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    assert.equal((await call('home_context')).member.id, home.member.id);
    await page.getByLabel('Email', { exact: true }).fill('owner@upgrade.test');
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Connect an assistant', exact: true })).toBeVisible();
    const oldTokens = tokens;
    await page.getByRole('button', { name: 'End access for Browser MCP verifier', exact: true }).click();
    await expect(page.getByText('Ended', { exact: true })).toBeVisible();
    const refused = await fetch(resource, { method: 'POST', headers: { Authorization: 'Bearer ' + oldTokens.access_token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }) });
    assert.equal(refused.status, 401);
    await refused.arrayBuffer();
    const refresh = await fetch(origin + '/api/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: information.client_id, refresh_token: oldTokens.refresh_token, resource }) });
    assert.equal(refresh.status, 400);
    assert.equal((await refresh.json()).error, 'invalid_grant');
    console.log('[mcp-ui] real two-tab cookie-writer ordering');
    await page.setViewportSize({ width: 1365, height: 900 });
    const beforePassword = (await http('/auth/status')).data.session;
    const other = await context.newPage();
    other.setDefaultTimeout(15000);
    other.on('pageerror', error => errors.push(error.message));
    await other.goto(origin + '/?view=account&action=password');
    await expect(other.getByLabel('Current password', { exact: true })).toBeVisible();
    await other.getByLabel('Current password', { exact: true }).fill(password);
    await other.getByLabel('New password', { exact: true }).fill('replacement fixture owner passphrase');
    await other.getByLabel('Confirm new password', { exact: true }).fill('replacement fixture owner passphrase');
    let renewalHeld;
    const held = new Promise(resolve => renewalHeld = resolve);
    const release = new Promise(resolve => releaseRenewal = resolve);
    let heldOnce = false, passwordRequests = 0;
    other.on('request', request => { if (request.url() === origin + '/api/v1/auth/password') passwordRequests++; });
    await page.route('**/api/v1/auth/status', async route => {
        if (heldOnce || route.request().headers()['x-homeos-session-renew'] !== '1') return route.continue();
        heldOnce = true;
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        assert.ok(response.headers()['set-cookie']);
        renewalHeld();
        await release;
        await route.fulfill({ response });
    });
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await Promise.race([held, new Promise((_, reject) => setTimeout(() => reject(Error('No renewing status request')), 5000))]);
    await other.getByRole('button', { name: 'Save password', exact: true }).click();
    await expect.poll(() => other.evaluate(async () => {
        const locks = await navigator.locks.query();
        const name = 'home-os:browser-auth-handshake:v1';
        return locks.held.some(lock => lock.name === name) && locks.pending.some(lock => lock.name === name);
    })).toBe(true);
    assert.equal(passwordRequests, 0, 'password writer must await the held old-cookie response');
    releaseRenewal();
    await expect(other.getByText('Password changed. All previous browser sessions and assistant connections have ended.', { exact: true })).toBeVisible();
    assert.equal(passwordRequests, 1);
    const afterPassword = await other.evaluate(async () => (await (await fetch('/api/v1/auth/status')).json()).data.session);
    assert.ok(afterPassword);
    assert.notEqual(afterPassword.sessionId, beforePassword.sessionId);
    assert.equal(afterPassword.expiresAt, null);
    await page.unroute('**/api/v1/auth/status');
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(async () => (await http('/auth/status')).data.session?.sessionId).toBe(afterPassword.sessionId);
    await other.close();
    console.log('[mcp-ui] Viewer browser consent, private controls and refused writes');
    await page.goto(origin + '/api/app?view=account');
    await expect(page.getByRole('heading', { name: 'Connect an assistant', exact: true })).toBeVisible();
    const viewerPassword = 'viewer fixture secret passphrase';
    const viewer = await page.evaluate(async ({ ownerId, password }) => {
        const response = await fetch('/api/v1/members', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HomeOS-Member': ownerId },
            body: JSON.stringify({ name: 'MCP viewer', email: 'viewer@upgrade.test', password, role: 'viewer' }),
        });
        const body = await response.json();
        return { status: response.status, member: body.data?.member, error: body.error };
    }, { ownerId: home.member.id, password: viewerPassword });
    assert.equal(viewer.status, 201, JSON.stringify(viewer.error));
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await client.close();
    information = tokens = verifier = discovery = undefined;
    provider.clientMetadata.client_name = 'Viewer MCP verifier';
    const viewerCallback = new Promise(resolve => finishCallback = resolve);
    assert.equal(await auth(provider, { serverUrl: resource, scope: 'home:access' }), 'REDIRECT');
    await page.getByLabel('Email', { exact: true }).fill('viewer@upgrade.test');
    await page.getByLabel('Password', { exact: true }).fill(viewerPassword);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Viewer MCP verifier', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Allow', exact: true }).click();
    const viewerReturned = await Promise.race([
        viewerCallback,
        new Promise((_, reject) => setTimeout(() => reject(Error('No Viewer callback')), 15000)),
    ]);
    assert.equal(viewerReturned.searchParams.get('state'), expectedState);
    assert.equal(await auth(provider, {
        serverUrl: resource, authorizationCode: viewerReturned.searchParams.get('code'),
        iss: viewerReturned.searchParams.get('iss'),
    }), 'AUTHORIZED');
    transport = new StreamableHTTPClientTransport(new URL(resource), { authProvider: provider });
    client = new Client({ name: 'home-os-viewer-proof', version: '1.0.0' });
    await client.connect(transport);
    const viewerTools = await client.listTools();
    assert.equal(viewerTools.tools.filter(tool => !tool.name.startsWith('ledger_')).length, 26);
    assert.equal(viewerTools.tools.filter(tool => tool.name.startsWith('ledger_')).length, 11);
    assert.equal((await call('home_context')).member.role, 'viewer');
    assert.ok((await call('contacts_list')).contacts.some(entry => entry.id === contact.id));
    const exclusiveTo = new Date(cookingDate + 'T00:00:00Z');
    exclusiveTo.setUTCDate(exclusiveTo.getUTCDate() + 1);
    assert.ok((await call('meals_list', { from: cookingDate, to: exclusiveTo.toISOString().slice(0, 10) })).meals.some(entry => entry.id === meal.id));
    await call('notification_preferences_set', { operationId: crypto.randomUUID(), mealReminders: false, pushEnabled: false });
    assert.equal((await call('notification_preferences_get')).preferences.mealReminders, false);
    for (const name of ['inventory_create', 'recipes_update', 'meal_attendance_set']) {
        await assert.rejects(client.callTool({ name, arguments: {} }), /Tool .* not found/);
    }
    const selectedInbox = await client.callTool({ name: 'notifications_list', arguments: { memberId: home.member.id } }).catch(error => error);
    if (selectedInbox instanceof Error) assert.match(selectedInbox.message, /validation|Invalid|unrecognized/i);
    else assert.equal(selectedInbox.isError, true);
    await page.goto(origin + '/?view=account');
    await expect(page.getByRole('heading', { name: 'Connect an assistant', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 320, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(evidence, 'viewer-account-320.png'), fullPage: true });
    await page.getByRole('button', { name: 'End access for Viewer MCP verifier', exact: true }).click();
    await expect(page.getByText('Ended', { exact: true })).toBeVisible();
    assert.deepEqual(errors, []);
    const summary = {
        sourceSha: newRef, officialClient: '@modelcontextprotocol/client2.4.0',
        checks: [
            'actual HTTPS discovery/DCR/S256 PKCE',
            'real browser first-owner setup preserves consent intent',
            'unverified client and loopback destination displayed',
            'explicit Allow validates callback state/issuer',
            'actual SDK commands in inventory, expenses, recipes, meals, attendance, contacts, reminders and membership; HTTP truth parity',
            'access rosters and human notification handoff disclose no native permission',
            'browser logout preserves independently approved MCP',
            'permanent null/public session ID',
            'Account and consent fit desktop390/320',
            'silent real SDK refresh without browser sign-in',
            'Account revoke immediately refuses old MCP bearer and refresh',
            'two real browser tabs serialize old-cookie renewal before password writer and retain the new cookie',
            'Viewer authorizes own client, reads tomorrow menu and contacts, changes own preferences, and is refused writes/attendance/selected inbox',
        ],
        uncaughtErrors: errors,
    };
    await writeFile(path.join(evidence, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
}
catch (error) {
    console.error(error.stack);
    console.error(logs.slice(-7000));
    if (page)
        await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => { });
    process.exitCode = 1;
}
finally {
    releaseRenewal?.();
    await client?.close().catch(() => { });
    await context?.close().catch(() => {});
    await stopWorker();
    if (callbackServer)
        await new Promise(resolve => callbackServer.close(resolve));
    await rm(temporary, { recursive: true, force: true });
}
