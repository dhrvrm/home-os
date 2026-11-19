import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, mkdir, rm, cp, stat } from 'node:fs/promises';
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
const temporary = await mkdtemp(path.join(os.tmpdir(), 'homeos-ledger-ui-'));
const evidence = path.join(root, 'test-results/ledger');
const state = path.join(temporary, 'state');
const node = process.execPath, setupToken = 'upgrade-fixture-setup-code', password = 'upgrade fixture owner passphrase';
let worker, context, logs = '', page, releaseLegacyStatus;
const contexts = [];
const actorClients = [];
const checks = [];
const oldRef = '8f45806d59d712d5096120a25cb45557e8bfff44';
const oldRoot = path.join(temporary, 'deployed-old');
let currentConfig;
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

function step(name) { console.log('[ledger-browser] ' + name); }
async function callbackWithin(promise,label='OAuth callback') {let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('No '+label+' within 15 seconds')),15000)})])}finally{clearTimeout(timer)}}
async function check(name, action) { step(name); await action(); checks.push(name); }
function observe(target) { target.on('pageerror', error => errors.push(error.message)); }
async function shot(name,fullPage=true) { await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.screenshot({path:path.join(evidence, name + '.png'), fullPage,animations:'disabled'}); }
async function http(target, route, {method='GET', body, operationId=crypto.randomUUID(), version, status=200}={}) {
  const result = await target.evaluate(async ({route,method,body,operationId,version}) => {
    const session = (await (await fetch('/api/v1/auth/status')).json()).data.session;
    const response = await fetch('/api/v1' + route, {method,headers:{'content-type':'application/json','X-HomeOS-Member':session.user.id,'X-Operation-ID':operationId,...(version?{'If-Match':String(version)}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  },{route,method,body,operationId,version});
  assert.equal(result.status,status,route+': '+JSON.stringify(result.body.error));
  return status>=400 ? result.body.error : result.body.data;
}
async function signIn(target,email) {
 await target.getByLabel('Email',{exact:true}).fill(email);
 await target.getByLabel('Password',{exact:true}).fill(password);
 await target.getByRole('button',{name:'Sign in',exact:true}).click();
 await expect(target.getByRole('button',{name:'Balances',exact:true})).toBeVisible();
}
async function noOverflow() { assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'page horizontal overflow'); }
let callbackServer, client, transport;
try {
 await rm(evidence,{recursive:true,force:true});await mkdir(evidence,{recursive:true});
 if(process.env.HOMEOS_SKIP_BUILD!=='1') await run('npm',['run','build','--workspace','@home-os/web']);
 await snapshot(oldRef,oldRoot,process.env.HOMEOS_LEDGER_OLD_DEPENDENCIES ? path.resolve(process.env.HOMEOS_LEDGER_OLD_DEPENDENCIES) : undefined);
 step('building faithful deployed 8f45806 archive');
 await run('npm',['run','build','--workspace','@home-os/web'],oldRoot);
 const keyPath=path.join(temporary,'key.pem'),certPath=path.join(temporary,'cert.pem');
 assert.equal(spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost','-keyout',keyPath,'-out',certPath],{stdio:'ignore'}).status,0);
 const cert=await readFile(certPath,'utf8');
 if(typeof tls.setDefaultCACertificates!=='function') throw Error('Use supported Node22.23.5 or newer Node22');
 tls.setDefaultCACertificates([...tls.getCACertificates('default'),cert]);
 const spki=createHash('sha256').update(new X509Certificate(cert).publicKey.export({type:'spki',format:'der'})).digest('base64');
 const port=await freePort(),origin=`https://127.0.0.1:${port}`,resource=origin+'/mcp';
 const oldConfig=await configure(oldRoot,origin);
 await startWorker(oldRoot,oldConfig,port,keyPath,certPath);
 context=await chromium.launchPersistentContext(path.join(temporary,'profile'),{channel:process.env.HOMEOS_BROWSER_CHANNEL||(process.platform==='darwin'?'chrome':'chromium'),headless:true,viewport:{width:1280,height:800},args:[`--ignore-certificate-errors-spki-list=${spki}`],serviceWorkers:'allow'});
 page=context.pages()[0]||await context.newPage(); observe(page);
 page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(30000);
 await check('deployed old installed shell, continuing session and actual offline inventory queue',async()=>{
  await page.goto(origin+'/?view=inventory');
  for(const [name,value] of [['Your name','Ledger owner'],['Email','owner@ledger.test'],['Password',password],['Confirm password',password],['Home setup code',setupToken]]) await page.getByLabel(name,{exact:true}).fill(value);
  await page.getByRole('button',{name:'Set up your home',exact:true}).click();
  await expect(page.getByRole('button',{name:'Add item',exact:true}).filter({visible:true}).first()).toBeVisible();
  await page.evaluate(async()=>{await navigator.serviceWorker.ready});
  await page.waitForFunction(()=>navigator.serviceWorker.controller!==null);
  const eligibility=await context.newCDPSession(page);assert.deepEqual((await eligibility.send('Page.getInstallabilityErrors')).installabilityErrors,[]);await eligibility.detach();
  const oldSW=context.serviceWorkers()[0],oldBuild=await oldSW.evaluate('BUILD.version');
  const beforeSession=await http(page,'/auth/status'); assert.equal(beforeSession.session.expiresAt,null);
  const beforeUser=beforeSession.session.user.id;
  await context.setOffline(true);
  await page.getByRole('button',{name:'Add item',exact:true}).filter({visible:true}).first().click();
  await page.getByLabel('Item name',{exact:true}).fill('Deployed queue rice');
  await page.getByRole('button',{name:'Save item',exact:true}).click();
  await expect.poll(async()=>(await stored()).operations.length).toBe(1);
  const queued=(await stored()).operations[0];
  await shot('deployed-old-offline');
  await stopWorker();
  currentConfig=await configure(root,origin);
  await startWorker(root,currentConfig,port,keyPath,certPath);
  await context.setOffline(false);
  await expect.poll(async()=>(await stored()).operations.length).toBe(0);
  const afterSession=await http(page,'/auth/status');
  assert.equal(afterSession.session.user.id,beforeUser);assert.equal(afterSession.session.sessionId,beforeSession.session.sessionId);assert.equal(afterSession.session.expiresAt,null);
  const audit=await http(page,'/items/'+queued.entityId+'/activity');
  assert.equal(audit.events.filter(e=>e.operationId===queued.operationId).length,1);
  assert.equal(await oldSW.evaluate('BUILD.version'),oldBuild);
  await page.goto(origin+'/api/app?view=account');
  await page.evaluate(async()=>{await (await navigator.serviceWorker.ready).update()});
  await page.waitForFunction(async()=>Boolean((await navigator.serviceWorker.getRegistration('/'))?.waiting));
  assert.equal(await oldSW.evaluate('BUILD.version'),oldBuild);
  await expect(page.getByRole('button',{name:'Update and reload',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Update and reload',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Connect an assistant',exact:true})).toBeVisible();
  await page.goto(origin+'/?view=inventory');
  await expect(page.getByText('Deployed queue rice',{exact:true}).first()).toBeVisible();
  assert.equal((await stored()).operations.length,0);
  await shot('deployed-updated-preserved');
 });
 const ownerId=(await http(page,'/auth/status')).session.user.id;
 const member=(await http(page,'/members',{method:'POST',status:201,body:{name:'Ledger member',email:'member@ledger.test',password,role:'member'}})).member;
 const viewer=(await http(page,'/members',{method:'POST',status:201,body:{name:'Ledger viewer',email:'viewer@ledger.test',password,role:'viewer'}})).member;
 const date='2026-11-19';
 const bill=(totalMinor,description='Parity bill')=>({kind:'expense',date,description,currency:'INR',totalMinor,payers:[{memberId:ownerId,amountMinor:totalMinor}],allocation:{kind:'split',split:{mode:'equal',participants:[{memberId:ownerId,kind:'equal'},{memberId:member.id,kind:'equal'}]}}});
 const open=async(query='')=>{await page.goto(origin+'/?view=expenses'+query);await expect(page.getByRole('button',{name:'Balances',exact:true})).toBeVisible()};
 let finishCallback;
 const callback=new Promise(resolve=>finishCallback=resolve);
 callbackServer=createCallbackServer((request,response)=>{response.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});response.end('<title>Ledger proof callback</title>Return to your assistant.');finishCallback(new URL(request.url,`http://127.0.0.1:${callbackServer.address().port}`))});
 await new Promise(resolve=>callbackServer.listen(0,'127.0.0.1',resolve));
 const callbackUrl=`http://127.0.0.1:${callbackServer.address().port}/callback`,expectedState=crypto.randomUUID();
 let information,tokens,verifier,discovery;
 const provider={redirectUrl:callbackUrl,clientMetadata:{client_name:'Ledger financial proof',redirect_uris:[callbackUrl],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']},state:()=>expectedState,clientInformation:()=>information,saveClientInformation:value=>{information=value},tokens:()=>tokens,saveTokens:value=>{tokens=value},saveCodeVerifier:value=>{verifier=value},codeVerifier:()=>verifier,saveDiscoveryState:value=>{discovery=value},discoveryState:()=>discovery,redirectToAuthorization:async url=>{await page.goto(url.href)}};
 await check('official SDK personal discovery, PKCE and explicit current-owner consent',async()=>{
  assert.equal(await auth(provider,{serverUrl:resource,scope:'home:access'}),'REDIRECT');
  await expect(page.getByRole('heading',{name:'Review access to your home',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Allow',exact:true}).click();
  const returned=await callbackWithin(callback);
  assert.equal(returned.searchParams.get('state'),expectedState);assert.equal(returned.searchParams.get('iss'),origin);
  assert.equal(await auth(provider,{serverUrl:resource,authorizationCode:returned.searchParams.get('code'),iss:origin}),'AUTHORIZED');
  transport=new StreamableHTTPClientTransport(new URL(resource),{authProvider:provider});client=new Client({name:'home-os-ledger-proof',version:'1.0.0'});await client.connect(transport);
  const tools=(await client.listTools()).tools.map(t=>t.name);assert.equal(tools.filter(n=>n.startsWith('ledger_')).length,19);
 });
 const call=async(name,args={})=>{const output=await client.callTool({name,arguments:args});assert.notEqual(output.isError,true,name+': '+JSON.stringify(output));return output.structuredContent};
 const parity=async()=>{
  const api=await http(page,'/ledger/balances?currency=INR');
  assert.deepEqual(await call('ledger_balances',{currency:'INR'}),api);
  assert.equal(api.items.reduce((sum,row)=>sum+row.netMinor,0),0);
  return api;
 };
 let expense;
 await check('real itemized multi-payer bill, calculator keyboard and exact AE5 allocation',async()=>{
  await open();await page.getByRole('button',{name:'Add expense',exact:true}).click();
  const dialog=page.locator('[role="dialog"]');
  await expect(dialog.getByLabel('Description',{exact:true})).toBeFocused();
  await dialog.getByLabel('Description',{exact:true}).fill('Itemized household dinner');
  await dialog.getByLabel('Date',{exact:true}).fill(date);
  await dialog.getByRole('combobox',{name:'Amount mode',exact:true}).selectOption('itemized');
  await dialog.getByLabel('Item 1 label',{exact:true}).fill('Owner dish');
  await dialog.getByRole('button',{name:'Calculate Item 1 unit amount',exact:true}).click();
  await dialog.getByLabel('Calculation for Item 1 unit amount',{exact:true}).fill('100+200');
  await dialog.getByLabel('Calculation for Item 1 unit amount',{exact:true}).press('Enter');
  assert.equal((await http(page,'/ledger/entries')).items.length,0);
  await dialog.getByRole('button',{name:'Apply INR 300.00',exact:true}).click();
  await expect(dialog.getByLabel('Item 1 unit amount',{exact:true})).toHaveValue('300.00');
  await expect(dialog.getByRole('button',{name:'Calculate Item 1 unit amount',exact:true})).toBeFocused();
  await dialog.getByRole('group',{name:'Item 1 shares',exact:true}).getByRole('checkbox',{name:'Ledger owner',exact:true}).check();
  await dialog.getByRole('button',{name:'Add item · 1/40',exact:true}).click();
  await dialog.getByLabel('Item 2 label',{exact:true}).fill('Member dish');
  await dialog.getByLabel('Item 2 unit amount',{exact:true}).fill('700');
  await dialog.getByRole('group',{name:'Item 2 shares',exact:true}).getByRole('checkbox',{name:'Ledger member',exact:true}).check();
  await dialog.getByLabel('Discount amount',{exact:true}).fill('100');
  await dialog.getByRole('combobox',{name:'Tax type',exact:true}).selectOption('percent');
  await dialog.getByLabel('Tax percent',{exact:true}).fill('10');
  await dialog.getByLabel('Tip amount',{exact:true}).fill('90');
  await dialog.getByLabel('Paid by Ledger owner',{exact:true}).fill('700');
  await dialog.getByRole('checkbox',{name:'Payer Ledger member',exact:true}).check();
  await dialog.getByLabel('Paid by Ledger member',{exact:true}).fill('380');
  await dialog.getByLabel('Category',{exact:true}).fill('Food');
  await dialog.getByLabel('Notes',{exact:true}).fill('Immutable explanation source');
  await expect(dialog.getByLabel('Share for Ledger owner',{exact:true})).toHaveText('₹324.00');
  await expect(dialog.getByLabel('Share for Ledger member',{exact:true})).toHaveText('₹756.00');
  for(const [width,height,theme] of [[320,568,'light'],[320,568,'dark'],[390,844,'light'],[390,844,'dark'],[1280,800,'light'],[1280,800,'dark'],[390,500,'dark']]){
   await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:theme});await noOverflow();
   await expect(dialog.locator('textarea')).toHaveCount(1);await dialog.locator('textarea').focus();await page.keyboard.press('Tab');
   await expect(dialog.getByRole('button',{name:'Cancel',exact:true})).toBeFocused();
   assert.equal(await dialog.evaluate(el=>el.contains(document.activeElement)),true,'focus escaped modal');
   await expect(dialog.getByRole('button',{name:'Save expense',exact:true})).toBeEnabled();
   await expect(dialog.getByRole('button',{name:'Cancel',exact:true})).toBeEnabled();
   await shot(`composer-review-${width}-${height}-${theme}`,false);
   await dialog.evaluate(el=>{el.scrollTop=0});await shot(`composer-${width}-${height}-${theme}`,false);
  }
  await page.setViewportSize({width:1280,height:800});await page.emulateMedia({colorScheme:'light'});
  await dialog.getByRole('button',{name:'Save expense',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Itemized household dinner',exact:true})).toBeVisible();
  expense=(await http(page,'/ledger/entries')).items[0];assert.equal(expense.intent.totalMinor,108000);
  assert.deepEqual(expense.shares.map(s=>s.amountMinor),[32400,75600]);
  assert.deepEqual((await call('ledger_entry_get',{entryId:expense.id})).entry,expense);
  const balances=await parity();assert.equal(balances.items.find(p=>p.memberId===ownerId).netMinor,37600);
  await shot('detail-itemized-desktop');
 });
 await check('immutable comment, correction, linked refund and retained reversal/replacement history',async()=>{
  const before=await parity();
  await page.getByRole('button',{name:'Add comment',exact:true}).click();
  await page.getByLabel('Comment',{exact:true}).fill('Dinner receipt checked by owner');
  await page.getByRole('button',{name:'Append comment',exact:true}).click();
  await expect(page.getByText('Dinner receipt checked by owner',{exact:true})).toBeVisible();
  assert.deepEqual(await parity(),before);
  await page.getByRole('button',{name:'Correct entry',exact:true}).click();
  await page.getByRole('dialog').getByLabel('Description',{exact:true}).fill('Itemized dinner corrected');
  await page.getByRole('button',{name:'Save correction',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Itemized dinner corrected',exact:true})).toBeVisible();
  expense=(await http(page,'/ledger/entries/'+expense.id)).entry;assert.equal(expense.version,2);
  await page.getByRole('button',{name:'Record refund',exact:true}).click();
  const dialog=page.locator('[role="dialog"]');
  await dialog.getByLabel('Description',{exact:true}).fill('Returned member dish');
  await dialog.getByLabel('Refund amount',{exact:true}).fill('100');
  await dialog.getByLabel('Refund date',{exact:true}).fill(date);
  await dialog.getByLabel('Returned to original payers: Ledger owner',{exact:true}).fill('100');
  await dialog.getByLabel('Credited beneficiaries: Ledger member',{exact:true}).fill('100');
  await dialog.getByRole('button',{name:'Record refund',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Returned member dish',exact:true})).toBeVisible();
  const credit=(await http(page,'/ledger/entries?kind=refund')).items[0];
  assert.equal((await parity()).items.find(p=>p.memberId===ownerId).netMinor,27600);
  await page.getByRole('button',{name:'Void entry',exact:true}).click();await page.getByRole('button',{name:'Confirm void',exact:true}).click();
  await expect(page.getByRole('button',{name:'Restore entry',exact:true})).toBeVisible();
  assert.equal((await parity()).items.find(p=>p.memberId===ownerId).netMinor,37600);
  await page.getByRole('button',{name:'Restore entry',exact:true}).click();await page.getByRole('button',{name:'Confirm restore',exact:true}).click();
  await expect(page.getByRole('button',{name:'Void entry',exact:true})).toBeVisible();
  assert.equal((await parity()).items.find(p=>p.memberId===ownerId).netMinor,27600);
  const history=await call('ledger_history_list',{entryId:credit.id});
  assert.deepEqual(history,await http(page,'/ledger/entries/'+credit.id+'/history'));
  assert.deepEqual(history.items.map(r=>r.action),['create','void','restore']);
  assert.ok(history.items.some(r=>r.transitions.some(t=>t.effectKind==='reversal')));
  await shot('refund-history');
 });
 await check('accepted payment response lost, reload, two-tab refusal marker and identical replay exactly once',async()=>{
  await open('&ledgerTab=balances');
  await page.getByRole('button',{name:'Record payment',exact:true}).click();
  const dialog=page.locator('[role="dialog"]');
  await dialog.getByRole('combobox',{name:'Sender',exact:true}).selectOption(member.id);
  await dialog.getByRole('combobox',{name:'Receiver',exact:true}).selectOption(ownerId);
  await dialog.getByLabel('Reported amount',{exact:true}).fill('50');
  await dialog.getByLabel('Payment date',{exact:true}).fill(date);
  await dialog.getByLabel('Method',{exact:true}).fill('cash');
  let accepted,operationId,posted;
  await page.route('**/api/v1/ledger/payments',async route=>{
   if(route.request().method()!=='POST') return route.continue();
   operationId=route.request().headers()['x-operation-id'];posted=route.request().postDataJSON();
   const response=await route.fetch();assert.equal(response.status(),201);accepted=(await response.json()).data.entry;
   await route.abort('connectionfailed');
  });
  await dialog.getByRole('button',{name:'Record payment',exact:true}).click();
  await expect(page.getByText('Save outcome unknown.',{exact:false}).first()).toBeVisible();
  assert.ok(accepted);assert.ok(operationId);
  await page.unroute('**/api/v1/ledger/payments');
  const retained=async target=>target.evaluate(async()=>{
   const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('home-os');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
   try{return await new Promise((resolve,reject)=>{const tx=db.transaction('householdCache','readonly');const request=tx.objectStore('householdCache').getAll();tx.oncomplete=()=>resolve(request.result.find(row=>row.key.includes('ledger:attempt:v1'))?.data);tx.onerror=()=>reject(tx.error)})}finally{db.close()}
  });
  const frozen=await retained(page);assert.equal(frozen.command.operationId,operationId);assert.equal(frozen.command.entry.totalMinor,5000);
  page.once('dialog',d=>d.accept());await page.reload();
  await expect(page.getByRole('button',{name:'Replay same save',exact:true})).toBeVisible();
  const other=await context.newPage();observe(other);await other.goto(origin+'/?view=expenses&ledgerTab=balances');
  await expect(other.getByRole('button',{name:'Replay same save',exact:true})).toBeVisible();
  await other.route('**/api/v1/ledger/payments',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({ok:false,data:null,error:{code:'conflict',message:'Delayed refusal while an earlier save may have committed'}})}));
  await other.getByRole('button',{name:'Replay same save',exact:true}).click();
  await expect(other.getByText('an earlier or concurrent request may still have been recorded',{exact:false})).toBeVisible();
  assert.equal((await retained(other)).mayHaveOtherRequest,true);
  assert.deepEqual((await retained(other)).command,frozen.command);
  await other.unroute('**/api/v1/ledger/payments');await other.close();
  await shot('payment-lost-response-recovery');
  await page.getByRole('button',{name:'Replay same save',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Recorded payment · Ledger member to Ledger owner',exact:true})).toBeVisible();
  assert.equal(await retained(page),undefined);
  const payments=await http(page,'/ledger/entries?kind=payment');assert.equal(payments.items.length,1);assert.equal(payments.items[0].id,accepted.id);
  const replay=await http(page,'/ledger/payments',{method:'POST',status:201,operationId,body:posted});assert.equal(replay.entry.id,accepted.id);
  await http(page,'/ledger/payments',{method:'POST',status:409,operationId,body:{...posted,totalMinor:5100}});
  const audit=await call('activity_list',{entityId:accepted.id});assert.equal(audit.events.filter(e=>e.operationId===operationId).length,1);
  assert.equal((await call('ledger_history_list',{entryId:accepted.id})).items.length,1);
  assert.equal((await parity()).items.find(p=>p.memberId===ownerId).netMinor,22600);
 });
 await check('recurring source uniqueness remains after void; catalog semantics are separate',async()=>{
  const rule=(await call('expenses_create',{operationId:crypto.randomUUID(),name:'Ledger rent rule',amountMinor:100,currency:'JPY',cadence:{unit:'month',interval:1,anchorDate:'2026-01-31'},participants:[{memberId:ownerId},{memberId:member.id}]})).rule;
  const post={ruleId:rule.id,expectedRuleVersion:1,period:1,date,payers:[{memberId:ownerId,amountMinor:100}]};
  const original=(await call('ledger_rule_post',{operationId:crypto.randomUUID(),...post})).entry;
  assert.equal(original.source.periodStart,'2026-02-28');assert.equal(original.source.periodEnd,'2026-03-31');
  await call('ledger_entry_void',{operationId:crypto.randomUUID(),entryId:original.id,expectedVersion:1});
  await http(page,'/ledger/rule-postings',{method:'POST',status:409,body:post});
  await open('&ledgerTab=rules');
  await expect(page.getByRole('heading',{name:'Recurring rules',exact:true})).toBeVisible();
  await expect(page.getByText('Ledger rent rule',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Add recurring rule',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Record period for Ledger rent rule',exact:true}).click();
  await page.getByLabel('Billing period number',{exact:true}).fill('1');
  await page.getByLabel('Actual expense date',{exact:true}).fill(date);
  await page.getByLabel('Actual contribution by Ledger owner',{exact:true}).fill('100');
  await page.getByRole('button',{name:'Record period expense',exact:true}).click();
  await expect(page.getByRole('button',{name:'Open existing original',exact:true})).toBeVisible();
  await shot('recurring-source-collision');
  await page.getByRole('button',{name:'Open existing original',exact:true}).click();
  await expect(page.getByRole('button',{name:'Restore entry',exact:true})).toBeVisible();
  assert.equal((await call('ledger_entries_list',{currency:'JPY',lifecycle:'all'})).items.length,1);
 });
 await check('member and viewer real browser/API/official SDK actors see the same money; viewer writes refused',async()=>{
  for(const account of [{email:'member@ledger.test',id:member.id,role:'member'},{email:'viewer@ledger.test',id:viewer.id,role:'viewer'}]){
   const c=await context.browser().newContext({viewport:{width:390,height:844},ignoreHTTPSErrors:true});contexts.push(c);
   const p=await c.newPage();observe(p);await p.goto(origin+'/?view=expenses');await signIn(p,account.email);
   assert.equal((await http(p,'/auth/status')).session.user.id,account.id);
   // Each actor authorizes its own real official SDK connection through the browser.
   let actorInfo,actorTokens,actorVerifier,actorDiscovery;
   const actorState=crypto.randomUUID(),actorCallback=new Promise(resolve=>finishCallback=resolve);
   const actorProvider={...provider,clientMetadata:{...provider.clientMetadata,client_name:'Ledger '+account.role+' proof'},state:()=>actorState,clientInformation:()=>actorInfo,saveClientInformation:value=>{actorInfo=value},tokens:()=>actorTokens,saveTokens:value=>{actorTokens=value},saveCodeVerifier:value=>{actorVerifier=value},codeVerifier:()=>actorVerifier,saveDiscoveryState:value=>{actorDiscovery=value},discoveryState:()=>actorDiscovery,redirectToAuthorization:async url=>{await p.goto(url.href)}};
   assert.equal(await auth(actorProvider,{serverUrl:resource,scope:'home:access'}),'REDIRECT');
   await expect(p.getByRole('heading',{name:'Review access to your home',exact:true})).toBeVisible();
   await p.getByRole('button',{name:'Allow',exact:true}).click();const returned=await callbackWithin(actorCallback);assert.equal(returned.searchParams.get('state'),actorState);
   assert.equal(await auth(actorProvider,{serverUrl:resource,authorizationCode:returned.searchParams.get('code'),iss:returned.searchParams.get('iss')}),'AUTHORIZED');
   const actorTransport=new StreamableHTTPClientTransport(new URL(resource),{authProvider:actorProvider}),actorClient=new Client({name:'home-os-ledger-'+account.role+'-proof',version:'1.0.0'});actorClients.push({client:actorClient,transport:actorTransport});await actorClient.connect(actorTransport);
   assert.equal((await actorClient.listTools()).tools.filter(t=>t.name.startsWith('ledger_')).length,account.role==='viewer'?11:19);
   await p.goto(origin+'/?view=expenses');await expect(p.getByRole('button',{name:'Balances',exact:true})).toBeVisible();
   const connected=await actorClient.callTool({name:'ledger_balances',arguments:{currency:'INR'}});assert.notEqual(connected.isError,true);assert.deepEqual(connected.structuredContent,await http(p,'/ledger/balances?currency=INR'));

   const truth=await http(p,'/ledger/balances?currency=INR');assert.deepEqual(truth,await http(page,'/ledger/balances?currency=INR'));
   if(account.role==='viewer'){
    await expect(p.getByText('Viewers can inspect shared finances but cannot record changes.',{exact:true})).toBeVisible();
    await expect(p.getByRole('button',{name:'Add expense',exact:true})).toHaveCount(0);
    await http(p,'/ledger/expenses',{method:'POST',status:403,body:bill(100,'Viewer prohibited')});
    await assert.rejects(actorClient.callTool({name:'ledger_payment_create',arguments:{}}),/Tool .* not found/);
    const restore=page;page=p;await shot('viewer-390');page=restore;
   }else{
    const memberResult=await actorClient.callTool({name:'ledger_expense_create',arguments:{operationId:crypto.randomUUID(),entry:bill(100,'Member accepted bill')}});assert.notEqual(memberResult.isError,true);const entry=memberResult.structuredContent.entry;
    assert.deepEqual((await http(p,'/ledger/entries/'+entry.id)).entry,entry);
    const comment=await http(p,'/ledger/entries/'+entry.id+'/comments',{method:'POST',status:201,version:1,body:{text:'Member API explanation'}});assert.equal(comment.comment.authorId,member.id);
    assert.deepEqual((await call('ledger_entry_get',{entryId:entry.id})).entry,entry);
   }
   await actorTransport.close();await actorClient.close();await c.close();
  }
  await parity();
 });
 await check('actual money layouts at 320/390/desktop in both themes with separate zero-decimal currency',async()=>{
  await call('ledger_expense_create',{operationId:crypto.randomUUID(),entry:{...bill(1,'Zero-decimal shared yen'),currency:'JPY',allocation:{kind:'split',split:{mode:'equal',participants:[{memberId:ownerId,kind:'equal'},{memberId:member.id,kind:'equal'},{memberId:viewer.id,kind:'equal'}]}}}});
  const yen=await call('ledger_balances',{currency:'JPY'});assert.equal(yen.items.reduce((sum,row)=>sum+row.netMinor,0),0);
  await call('ledger_expense_create',{operationId:crypto.randomUUID(),entry:{...bill(10000000000,'Maximum exact supported amount'),currency:'USD',allocation:{kind:'split',split:{mode:'equal',participants:[{memberId:ownerId,kind:'equal'}]}}}});
  await page.setViewportSize({width:320,height:568});await open('&currency=USD');await expect(page.getByText('Maximum exact supported amount',{exact:true})).toBeVisible();await page.getByText('Maximum exact supported amount',{exact:true}).scrollIntoViewIfNeeded();await expect(page.getByRole('article').filter({hasText:'Maximum exact supported amount'}).locator('output')).toContainText('10,00,00,000.00');await noOverflow();await shot('maximum-amount-320',false);

  await open('&currency=JPY');await expect(page.getByText('Zero-decimal shared yen',{exact:true})).toBeVisible();
  await page.getByText('Zero-decimal shared yen',{exact:true}).scrollIntoViewIfNeeded();await shot('zero-decimal-JPY',false);
  for(const width of [320,390,1280]) for(const theme of ['light','dark']){
   await page.setViewportSize({width,height:width===320?568:width===390?844:800});await page.emulateMedia({colorScheme:theme});
   await open();await noOverflow();await expect(page.getByRole('button',{name:'Add expense',exact:true})).toBeEnabled();await shot(`entries-${width}-${theme}`,false);
   await page.getByRole('button',{name:'Balances',exact:true}).click();await expect(page.getByRole('heading',{name:'Balances · INR',exact:true})).toBeVisible();await noOverflow();await shot(`balances-${width}-${theme}`);
  }
 });
 await check('complete paged statements, revision restart and actual consistent CSV/JSON downloads',async()=>{
  // More than one API page contributes to the same complete balance.
  for(let i=0;i<55;i++) await call('ledger_expense_create',{operationId:crypto.randomUUID(),entry:bill(2,`Page bill ${i}`)});
  const scoped={memberId:ownerId,currency:'INR'};
  const first=await call('ledger_statement',{...scoped,limit:1});assert.ok(first.nextCursor);
  const changed=(await call('ledger_expense_create',{operationId:crypto.randomUUID(),entry:bill(2,'=Formula-safe text')})).entry;
  const stale=await client.callTool({name:'ledger_statement',arguments:{...scoped,limit:1,cursor:first.nextCursor}});assert.equal(stale.isError,true);
  const statement=await call('ledger_statement',scoped);assert.ok(statement.movementCount>50);assert.equal(statement.openingMinor+statement.movementMinor,statement.closingMinor);
  await open('&ledgerTab=balances&statementMemberId='+encodeURIComponent(ownerId));
  await expect(page.getByRole('heading',{name:'Statement · Ledger owner · INR',exact:true})).toBeVisible();
  const downloads={};
  for(const format of ['CSV','JSON']){
   const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Export complete '+format,exact:true}).click();
   const download=await pending;assert.equal(await download.failure(),null);const destination=path.join(evidence,'statement.'+format.toLowerCase());await download.saveAs(destination);downloads[format]=await readFile(destination,'utf8');
   assert.ok(Buffer.byteLength(downloads[format])<=8388608);
  }
  const json=JSON.parse(downloads.JSON);assert.equal(json.scope.basis,'current-effective');assert.equal(json.scope.memberId,ownerId);assert.equal(json.scope.currency,'INR');assert.equal(json.revision,statement.revision);assert.equal(json.movementCount,statement.movementCount);assert.equal(json.items.length,statement.movementCount);assert.equal(json.openingMinor+json.items.reduce((n,r)=>n+r.amountMinor,0),json.closingMinor);
  assert.ok(downloads.CSV.includes('"revision",'+statement.revision));assert.ok(downloads.CSV.includes('"basis","current-effective"'));assert.ok(downloads.CSV.includes("'=Formula-safe text"));
  assert.equal(json.items.filter(row=>row.entryId===changed.id).length,1);
  // These fixture descriptions are single-line; compare every downloaded record,
  // including escaped CSV fields, against the complete JSON statement.
  const csvRecords=downloads.CSV.trimEnd().split('\r\n').map(line=>Array.from(line.matchAll(/"((?:""|[^"])*)"(?=,|$)/g),match=>match[1].replaceAll('""','"')));
  const headerIndex=csvRecords.findIndex(row=>row[0]==='entry_id');assert.ok(headerIndex>=0);
  const moneyMinor=value=>{assert.match(value,/^-?\d+\.\d{2}$/);return BigInt(value.replace('.',''))};
  const financialRows=csvRecords.slice(headerIndex+1);assert.equal(financialRows.length,json.items.length);
  for(let i=0;i<financialRows.length;i++){const row=financialRows[i],fact=json.items[i];assert.equal(row.length,8);assert.equal(row[0],fact.entryId);assert.equal(Number(row[1]),fact.version);assert.equal(row[2],fact.date);assert.equal(row[5],fact.currency);assert.equal(moneyMinor(row[6]),BigInt(fact.amountMinor));assert.equal(moneyMinor(row[7]),BigInt(fact.runningMinor))}

  const balance=(await parity()).items.find(p=>p.memberId===ownerId);assert.equal(json.closingMinor,balance.netMinor);
  for(const width of [320,390,1280]) for(const theme of ['light','dark']){
   await page.setViewportSize({width,height:width===320?568:width===390?844:800});await page.emulateMedia({colorScheme:theme});await noOverflow();await page.evaluate(()=>window.scrollTo(0,0));await shot(`statement-${width}-${theme}`,false);
  }

  // Cancel after the first real page, release the delayed continuation, and then
  // complete a fresh export. A cancelled preparation must never download a file.
  await open('&ledgerTab=balances&statementMemberId='+encodeURIComponent(ownerId));
  let releaseContinuation,signalContinuation,signalReleased,cancelled=false,cancelDownloads=0;
  const continuationHeld=new Promise(resolve=>releaseContinuation=resolve),continuationArrived=new Promise(resolve=>signalContinuation=resolve),continuationReleased=new Promise(resolve=>signalReleased=resolve);
  const observeCancelledDownload=()=>cancelDownloads++;page.on('download',observeCancelledDownload);
  await page.route('**/api/v1/ledger/export?**',async route=>{
   const response=await route.fetch();
   if(new URL(route.request().url()).searchParams.has('cursor')){signalContinuation();await continuationHeld;try{await route.fulfill({response})}catch(error){if(!cancelled)throw error}finally{signalReleased()}}
   else await route.fulfill({response});
  });
  await page.getByRole('button',{name:'Export complete JSON',exact:true}).click();await callbackWithin(continuationArrived,'statement continuation');
  cancelled=true;await page.getByRole('button',{name:'Cancel export',exact:true}).click();releaseContinuation();await callbackWithin(continuationReleased,'cancelled continuation release');
  await expect(page.getByRole('region',{name:'Member statement',exact:true}).getByRole('alert')).toContainText('cancelled');
  await expect(page.getByRole('button',{name:'Export complete JSON',exact:true})).toBeEnabled();assert.equal(cancelDownloads,0);
  page.off('download',observeCancelledDownload);await page.unroute('**/api/v1/ledger/export?**');
  const restartedDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Export complete JSON',exact:true}).click();
  const restarted=await restartedDownload;assert.equal(await restarted.failure(),null);const restartedPath=path.join(evidence,'statement-after-cancel.json');await restarted.saveAs(restartedPath);
  assert.deepEqual(JSON.parse(await readFile(restartedPath,'utf8')),json);
  // A server refusal flag is independently honored even when the count fits.
  await page.route('**/api/v1/ledger/export?**',async route=>{const response=await route.fetch();const body=await response.json();body.data.requiresNarrowerRange=true;await route.fulfill({response,json:body})});
  let flaggedDownloads=0;const observeFlagged=()=>flaggedDownloads++;page.on('download',observeFlagged);
  await page.getByRole('button',{name:'Export complete JSON',exact:true}).click();await expect(page.getByRole('region',{name:'Member statement',exact:true}).getByRole('alert')).toContainText('narrower');assert.equal(flaggedDownloads,0);
  page.off('download',observeFlagged);await page.unroute('**/api/v1/ledger/export?**');
  // Export limits are enforced on actual clicked browser controls, without creating 10k ledger facts.
  await page.route('**/api/v1/ledger/export?**',async route=>{
   const response=await route.fetch();const body=await response.json();body.data.movementCount=10001;await route.fulfill({response,json:body});
  });
  let excessDownloads=0;const onDownload=()=>excessDownloads++;page.on('download',onDownload);
  await page.getByRole('button',{name:'Export complete JSON',exact:true}).click();
  await expect(page.getByRole('region',{name:'Member statement',exact:true}).getByRole('alert')).toContainText('narrower');assert.equal(excessDownloads,0);page.off('download',onDownload);await page.unroute('**/api/v1/ledger/export?**');
  await open('&ledgerTab=balances&statementMemberId='+encodeURIComponent(ownerId));
  await page.route('**/api/v1/ledger/export?**',async route=>{
   const response=await route.fetch();const body=await response.json();body.data.csv+='界'.repeat(2796203);await route.fulfill({response,json:body});
  });
  let oversizedDownloads=0;const oversized=()=>oversizedDownloads++;page.on('download',oversized);
  await page.getByRole('button',{name:'Export complete CSV',exact:true}).click();
  await expect(page.getByRole('region',{name:'Member statement',exact:true}).getByRole('alert')).toContainText('8 MiB');assert.equal(oversizedDownloads,0);page.off('download',oversized);await page.unroute('**/api/v1/ledger/export?**');
  await open('&ledgerTab=balances&statementMemberId='+encodeURIComponent(ownerId));
  let revised=false,interruptedDownloads=0;
  const observeDownload=()=>interruptedDownloads++;page.on('download',observeDownload);
  await page.route('**/api/v1/ledger/export?**',async route=>{
   const response=await route.fetch();
   if(!revised&&response.ok()){
    const firstPage=(await response.json()).data;
    if(firstPage.nextCursor){revised=true;await call('ledger_entry_correct',{operationId:crypto.randomUUID(),entryId:changed.id,expectedVersion:1,entry:{...changed.intent,description:'Corrected while export pages were loading'}})}
   }
   await route.fulfill({response});
  });
  await page.getByRole('button',{name:'Export complete JSON',exact:true}).click();
  await expect(page.getByRole('region',{name:'Member statement',exact:true}).getByRole('alert')).toContainText(/restart/i);
  assert.equal(revised,true);assert.equal(interruptedDownloads,0);page.off('download',observeDownload);await page.unroute('**/api/v1/ledger/export?**');
  await open('&ledgerTab=balances&statementMemberId='+encodeURIComponent(ownerId)+'&from=2027-01-01&to=2027-01-31');
  await expect(page.getByText('No movements in this statement scope.',{exact:true})).toBeVisible();
  for(const format of ['CSV','JSON']){
   const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Export complete '+format,exact:true}).click();const download=await pending;const destination=path.join(evidence,'statement-empty.'+format.toLowerCase());await download.saveAs(destination);const text=await readFile(destination,'utf8');
   if(format==='JSON'){const value=JSON.parse(text);assert.equal(value.items.length,0);assert.equal(value.movementCount,0);assert.equal(value.openingMinor,value.closingMinor);assert.equal(value.scope.from,'2027-01-01');assert.equal(value.scope.to,'2027-01-31')}
   else {assert.ok(text.includes('"movement_count",0'));assert.ok(text.includes('"from_inclusive","2027-01-01"'));assert.ok(text.includes('"basis","current-effective"'))}
  }

 });
 await check('cached financial reads reopen offline and never enqueue financial writes',async()=>{
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({colorScheme:'dark'});await open('&ledgerTab=balances');
  await expect(page.getByRole('heading',{name:'Balances · INR',exact:true})).toBeVisible();
  await context.setOffline(true);await page.reload();
  await expect(page.getByText('Offline · saved financial copies are read-only. Connect to record changes.',{exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Balances · INR',exact:true})).toBeVisible();
  await page.evaluate(()=>window.scrollTo(0,0));await shot('offline-balances-readonly',false);
  await page.getByRole('button',{name:'Record payment',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('button',{name:'Record payment',exact:true})).toBeDisabled();
  assert.equal((await stored()).operations.length,0);await shot('offline-payment-disabled',false);
  await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await context.setOffline(false);
 });
 await check('isolated D1 aggregate row evidence uses --command JSON, not file execution summaries',async()=>{
  const sql="SELECT e.currency, COUNT(*) AS effective_entries, SUM(e.total_minor) AS effective_minor FROM ledger_entries e WHERE lifecycle='effective' GROUP BY e.currency; SELECT e.currency, SUM(f.amount_minor) AS net_minor FROM ledger_entries e JOIN ledger_effects f ON f.household_id=e.household_id AND f.entry_id=e.id AND f.version=e.version AND f.effect_kind='snapshot' WHERE e.lifecycle='effective' GROUP BY e.currency; SELECT COUNT(*) AS accepted_operations FROM household_command_receipts WHERE entity_type IN ('ledger_entry','ledger_comment');";
  const output=await run(node,[path.join(root,'node_modules/wrangler/bin/wrangler.js'),'d1','execute','home-os','--local','--persist-to',state,'--config',currentConfig,'--command',sql,'--json']);
  const rows=JSON.parse(output);assert.equal(rows.length,3);assert.ok(rows[0].results.length>0);assert.ok(rows[1].results.every(row=>row.net_minor===0));assert.ok(rows[2].results[0].accepted_operations>0);
  await writeFile(path.join(evidence,'d1-aggregate-rows.json'),JSON.stringify(rows,null,2));
 });
 assert.deepEqual(errors,[]);
 await writeFile(path.join(evidence,'summary.json'),JSON.stringify({oldRef,newRef,checks,uncaughtErrors:errors,limitations:['Software keyboard and screen-reader speech require a device/manual pass; short viewport and accessible labels exercised in Chrome.','Export 10001-row and UTF-8 8MiB refusal fixtures are routed; accepted artifacts and correction-between-pages refusal use the real server.'],cleanup:'finally closes SDK, callback listener, browser contexts, Worker and removes isolated archive/profile/D1/certificates'},null,2));
 step('all integrated checks passed');
}catch(error){
 console.error(error.stack);console.error(logs);
 await page?.screenshot({path:path.join(evidence,'failure.png'),fullPage:true}).catch(()=>{});
 await writeFile(path.join(evidence,'failure-dom.html'),await page.content()).catch(()=>{});process.exitCode=1;
}finally{
 await transport?.close().catch(()=>{});await client?.close().catch(()=>{});
 if(callbackServer) {callbackServer.closeAllConnections();await new Promise(resolve=>callbackServer.close(resolve));}
 for(const actor of actorClients){await actor.transport.close().catch(()=>{});await actor.client.close().catch(()=>{});}
 for(const c of contexts) await c.close().catch(()=>{});
 await context?.close().catch(()=>{});await stopWorker();await rm(temporary,{recursive:true,force:true});
 await writeFile(path.join(evidence,'cleanup.json'),JSON.stringify({temporaryRemoved:!(await stat(temporary).then(()=>true,()=>false)),workerStopped:!worker,callbackClosed:!callbackServer?.listening,browserClosed:!context||context.pages().length===0},null,2));
}
