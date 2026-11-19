import { env } from 'cloudflare:workers';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { mcpRequest, personalOAuth, realFetch, resetOAuthFixtures, measuredFetch, browserRequest, browserProof, tokenRequest, resource, overriddenFetch, data } from './oauth-fixtures';
async function rpc(response: Response) { const body = await response.text(); return JSON.parse(body.startsWith('event:') || body.startsWith('data:') ? body.split('\n').find(line => line.startsWith('data: '))!.slice(6) : body); }
const U5_OPERATIONS=['home_context','recipes_list','recipes_get','recipes_create','recipes_update','recipes_archive','recipes_restore','meals_list','meals_get','meals_create','meals_update','meals_cancel','meal_attendance_set','contacts_list','contacts_get','contacts_create','contacts_update','contacts_archive','contacts_restore','notifications_list','notifications_mark_read','notification_preferences_get','notification_preferences_set','members_list','members_update','connections_list','connections_revoke','sessions_list','sessions_revoke','account_password_change','member_access_setup','member_password_reset','notification_device_setup'] as const;
const bindingCounts:Record<string,number>={};
async function invoke(token: string, name: string, args: unknown = {}, fetch?: typeof realFetch) {
 const measured=fetch?null:measuredFetch();
 const response=await (fetch??measured!.fetch)(mcpRequest(token,'tools/call',{name,arguments:args}));
 const body=await rpc(response);
 if(measured){const count=measured.requests.d1+measured.requests.kv;bindingCounts[name]=Math.max(bindingCounts[name]??0,count);expect(count).toBeLessThanOrEqual(50);}
 return body.result;
}
afterAll(()=>{expect(Object.keys(bindingCounts)).toEqual(expect.arrayContaining([...U5_OPERATIONS]));expect(Math.max(...Object.values(bindingCounts))).toBeLessThanOrEqual(50);console.log('U5 combined conservative binding maxima',JSON.stringify(bindingCounts));});
beforeEach(async()=>{
 await resetOAuthFixtures();
 await env.DB.batch(['notifications','notification_preferences','meals','recipes','contacts','inventory_items'].map(table=>env.DB.prepare(`DELETE FROM ${table}`)));
});
it('exposes connected cooking, contacts, personal state, access and interactive boundaries', async () => {
 const oauth = await personalOAuth('owner','household-owner');
 const listed = await rpc(await realFetch(mcpRequest(oauth.tokens.access_token)));
 for (const name of U5_OPERATIONS) expect(listed.result.tools.map((t:{name:string})=>t.name)).toContain(name);
});

const recipeInput={name:'Connected dal',servings:4,ingredients:[{name:'Salt'}],instructions:'Cook gently',labels:['Dinner']};
function addDays(date:string,n:number){return new Date(Date.parse(`${date}T00:00:00Z`)+n*86400000).toISOString().slice(0,10);}
it('uses real cooking services: availability, multiple snapshots, tomorrow/seven-day dates, own responses, reconfirmation and cancellation',async()=>{
 const oauth=await personalOAuth('member','cooking-member'),token=oauth.tokens.access_token;
 const item=(await invoke(token,'inventory_create',{operationId:'salt',name:'Salt',unit:'kg',trackingMode:'exact',quantity:3})).structuredContent.item;
 const r1=(await invoke(token,'recipes_create',{...recipeInput,operationId:'dal',ingredients:[{name:'Salt',quantity:1,unit:'kg',inventoryItemId:item.id}]})).structuredContent.recipe;
 expect(r1.availability).toMatchObject({state:'ready',ingredients:[{availableQuantity:3}]});
 const r2=(await invoke(token,'recipes_create',{...recipeInput,name:'Rice',operationId:'rice'})).structuredContent.recipe;
 expect(await invoke(token,'recipes_get',{recipeId:r1.id})).toMatchObject({structuredContent:{recipe:{id:r1.id,version:1}}});
 expect(await invoke(token,'recipes_update',{recipeId:r1.id,operationId:'dal-update',expectedVersion:1,description:'Fresh'})).toMatchObject({structuredContent:{recipe:{version:2}}});
 expect(await invoke(token,'recipes_update',{recipeId:r1.id,operationId:'dal-stale',expectedVersion:1,description:'Stale'})).toMatchObject({isError:true,structuredContent:{status:'conflict',current:{version:2}}});
 const ctx=(await invoke(token,'home_context')).structuredContent,tomorrow=addDays(ctx.localDate,1);
 expect(ctx).toMatchObject({member:{id:'cooking-member',role:'member'},timezone:'Asia/Kolkata',approvedRole:'member',currentConnectionId:expect.stringMatching(/^[a-f0-9]{32}$/)});
 const m=(await invoke(token,'meals_create',{operationId:'meal',title:'Dinner',recipeIds:[r1.id,r2.id],cookingAt:`${tomorrow}T19:00`,timezone:ctx.timezone})).structuredContent.meal;
 expect(m.recipes.map((r:{name:string})=>r.name)).toEqual(['Connected dal','Rice']);
 const tomorrowPage=(await invoke(token,'meals_list',{from:tomorrow,to:addDays(tomorrow,1)})).structuredContent;
 expect(tomorrowPage).toMatchObject({timezone:ctx.timezone,from:tomorrow,to:addDays(tomorrow,1),meals:[{id:m.id}]});
 expect((await invoke(token,'meals_list',{from:ctx.localDate,to:addDays(ctx.localDate,7)})).structuredContent.meals.some((x:{id:string})=>x.id===m.id)).toBe(true);
 expect(await invoke(token,'meal_attendance_set',{mealId:m.id,operationId:'yes',response:'yes',announcementVersion:1,expectedResponseVersion:0})).toMatchObject({structuredContent:{meal:{myAttendance:{memberId:'cooking-member',response:'yes',responseVersion:1}}}});
 expect(await invoke(token,'meal_attendance_set',{mealId:m.id,operationId:'stale-answer',response:'no',announcementVersion:1,expectedResponseVersion:0})).toMatchObject({isError:true,structuredContent:{status:'conflict'}});
 await invoke(token,'recipes_update',{recipeId:r1.id,operationId:'recipe-later',expectedVersion:2,name:'New dal'});
 expect(await invoke(token,'meals_get',{mealId:m.id})).toMatchObject({structuredContent:{meal:{recipes:[{name:'Connected dal'},{name:'Rice'}]}}});
 expect(await invoke(token,'meals_update',{mealId:m.id,operationId:'note',expectedVersion:1,notes:'Come soon'})).toMatchObject({structuredContent:{meal:{version:2,announcementVersion:1,myAttendance:{response:'yes'}}}});
 expect(await invoke(token,'meals_update',{mealId:m.id,operationId:'time',expectedVersion:2,cookingAt:`${tomorrow}T20:00`})).toMatchObject({structuredContent:{meal:{version:3,announcementVersion:2,myAttendance:{response:'pending',needsReconfirmation:true}}}});
 for(const [index,response] of ['no','pending','yes'].entries())expect(await invoke(token,'meal_attendance_set',{mealId:m.id,operationId:`answer-${index}`,response,announcementVersion:2,expectedResponseVersion:index+1})).toMatchObject({structuredContent:{meal:{myAttendance:{response,responseVersion:index+2}}}});
 expect(await invoke(token,'meals_cancel',{mealId:m.id,operationId:'cancel',expectedVersion:3})).toMatchObject({structuredContent:{meal:{version:4,status:'cancelled'}}});
 expect(await invoke(token,'meal_attendance_set',{mealId:m.id,operationId:'closed',response:'yes',announcementVersion:2,expectedResponseVersion:4})).toMatchObject({isError:true,structuredContent:{status:'invalid'}});
 expect((await invoke(token,'meals_list',{from:tomorrow,to:addDays(tomorrow,1)})).structuredContent.meals).toEqual([]);
 expect((await invoke(token,'meals_list',{from:tomorrow,to:addDays(tomorrow,1),includeCancelled:true})).structuredContent.meals).toHaveLength(1);
 expect(await data(await realFetch(browserRequest(oauth.browser,`/api/v1/meals/${m.id}`)))).toMatchObject({meal:{id:m.id,version:4,status:'cancelled'}});
 expect(await invoke(token,'inventory_get',{itemId:item.id})).toMatchObject({structuredContent:{item:{quantity:3,version:1}}});
 for(const [name,expectedVersion] of [['recipes_archive',3],['recipes_restore',4]] as const)expect(await invoke(token,name,{recipeId:r1.id,operationId:name,expectedVersion})).toMatchObject({structuredContent:{recipe:{version:expectedVersion+1}}});
 const audit=await env.DB.prepare("SELECT actor_id,actor_type,source,mcp_client_id,mcp_tool FROM audit_events WHERE operation_id='cancel'").first();
 expect(audit).toEqual({actor_id:'cooking-member',actor_type:'mcp',source:'mcp',mcp_client_id:oauth.client.client_id,mcp_tool:'meals_cancel'});
});
it('shares contact lifecycle, normalized channels, API state and version conflicts',async()=>{
 const oauth=await personalOAuth('member','contact-member'),token=oauth.tokens.access_token;
 const args={operationId:'contact',name:'Plumber',role:'Repairs',phone:'+91 (123) 456-789',email:'help@example.com',labels:['Emergency']};
 const c=(await invoke(token,'contacts_create',args)).structuredContent.contact;
 expect(c).toMatchObject({phone:'+91123456789',version:1});
 expect(await invoke(token,'contacts_create',args)).toMatchObject({structuredContent:{contact:{id:c.id,version:1}}});
 expect(await invoke(token,'contacts_update',{contactId:c.id,operationId:'contact-update',expectedVersion:1,notes:'Call mornings'})).toMatchObject({structuredContent:{contact:{version:2,notes:'Call mornings'}}});
 expect(await invoke(token,'contacts_update',{contactId:c.id,operationId:'contact-stale',expectedVersion:1,name:'Bad'})).toMatchObject({isError:true,structuredContent:{status:'conflict',current:{version:2}}});
 expect(await invoke(token,'contacts_get',{contactId:c.id})).toMatchObject({structuredContent:{contact:{version:2}}});
 expect(await data(await realFetch(browserRequest(oauth.browser,`/api/v1/contacts/${c.id}`)))).toMatchObject({contact:{version:2,notes:'Call mornings'}});
 expect(await invoke(token,'contacts_archive',{contactId:c.id,operationId:'contact-archive',expectedVersion:2})).toMatchObject({structuredContent:{contact:{version:3,archivedAt:expect.any(String)}}});
 expect(await invoke(token,'contacts_restore',{contactId:c.id,operationId:'contact-restore',expectedVersion:3})).toMatchObject({structuredContent:{contact:{version:4,archivedAt:null}}});
 expect((await invoke(token,'contacts_list',{search:'Plumber'})).structuredContent.contacts.some((x:{id:string})=>x.id===c.id)).toBe(true);
 expect(await invoke(token,'contacts_create',{operationId:'bad-phone',name:'Bad',phone:'secret'})).toMatchObject({isError:true});
});
it('keeps private preference retries bound to the accepted operation without replaying an old change',async()=>{
 const oauth=await personalOAuth('viewer','private-viewer'),token=oauth.tokens.access_token;
 const a={operationId:'private-A',mealReminders:false,pushEnabled:false};
 expect(await invoke(token,'notification_preferences_set',a)).toMatchObject({structuredContent:{preferences:{mealReminders:false}}});
 await invoke(token,'notification_preferences_set',{operationId:'private-B',mealReminders:true,pushEnabled:true});
 expect(await invoke(token,'notification_preferences_set',a)).toMatchObject({structuredContent:{status:'accepted',preferences:{mealReminders:false,pushEnabled:false}}});
 expect(await invoke(token,'notification_preferences_get')).toMatchObject({structuredContent:{preferences:{mealReminders:true,pushEnabled:true}}});
 expect(await invoke(token,'notification_preferences_set',{...a,mealReminders:true})).toMatchObject({isError:true,structuredContent:{status:'conflict'}});
 expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE operation_id LIKE 'private-%'").first()).toMatchObject({count:0});
});

it.each(['owner','member','viewer'] as const)('keeps %s inbox/read state private and durable after inbox expiry',async role=>{
 const oauth=await personalOAuth(role,`notices-${role}`),token=oauth.tokens.access_token,memberId=oauth.browser.memberId,now=new Date().toISOString();
 await env.DB.prepare(`INSERT INTO meals (id,household_id,title,cooking_at,timezone,reminder_at,recipes_json,created_at,updated_at) VALUES ('notice-meal','home','Private reminder','2090-01-01T12:00:00Z','Asia/Kolkata','2090-01-01T11:00:00Z','[]',?,?) ON CONFLICT DO NOTHING`).bind(now,now).run();
 await browserProof('viewer','other-notices');
 await env.DB.batch([memberId,'other-notices'].map(id=>env.DB.prepare(`INSERT INTO notifications (id,household_id,member_id,title,body,meal_id,announcement_version,url,created_at) VALUES (?,'home',?,'Private title','PRIVATE_BODY_MUST_NOT_BE_RETAINED','notice-meal',1,'/?view=meals',?)`).bind(`notice-${id}`,id,now)));
 const inbox=(await invoke(token,'notifications_list')).structuredContent;
 expect(inbox).toMatchObject({limit:50,nextCursor:null,unreadCount:1,notifications:[{id:`notice-${memberId}`}]});
 const mark={operationId:'private-read',notificationId:`notice-${memberId}`};
 expect(await invoke(token,'notifications_mark_read',mark)).toMatchObject({structuredContent:{status:'accepted',notification:{id:mark.notificationId,read:true}}});
 expect(await data(await realFetch(browserRequest(oauth.browser,'/api/v1/notifications')))).toMatchObject({unreadCount:0,notifications:[{readAt:expect.any(String)}]});
 expect(await invoke(token,'notifications_mark_read',{operationId:'not-own',notificationId:'notice-other-notices'})).toMatchObject({isError:true,structuredContent:{code:'not_found'}});
 const leaked=await rpc(await realFetch(mcpRequest(token,'tools/call',{name:'notifications_list',arguments:{memberId:'other-notices'}})));
 expect(leaked.error||leaked.result?.isError).toBeTruthy();
 await invoke(token,'notification_preferences_set',{operationId:'private-preferences',mealReminders:false,pushEnabled:true});
 expect(await data(await realFetch(browserRequest(oauth.browser,'/api/v1/notifications/preferences')))).toMatchObject({preferences:{mealReminders:false,pushEnabled:true}});
 const receipts=await env.DB.prepare("SELECT result_json FROM household_command_receipts WHERE operation_id IN ('private-read','private-preferences')").all<{result_json:string}>();
 expect(JSON.stringify(receipts.results)).not.toContain('PRIVATE_BODY_MUST_NOT_BE_RETAINED');
 expect(JSON.stringify(receipts.results)).not.toContain('Private title');
 expect(JSON.parse(receipts.results[0]!.result_json)).toMatchObject({provenance:{source:'mcp',clientId:oauth.client.client_id}});
 expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE operation_id IN ('private-read','private-preferences')").first()).toMatchObject({count:0});
 await env.DB.prepare('DELETE FROM notifications WHERE id=?').bind(mark.notificationId).run();
 expect(await invoke(token,'notifications_mark_read',mark)).toMatchObject({structuredContent:{notification:{read:true}}});
 expect(await invoke(token,'notifications_mark_read',{...mark,notificationId:'notice-other-notices'})).toMatchObject({isError:true,structuredContent:{status:'conflict'}});
 const other=await personalOAuth('viewer','other-notices');
 expect(await invoke(other.tokens.access_token,'notifications_mark_read',mark)).toMatchObject({isError:true,structuredContent:{status:'conflict'}});
 await env.DB.prepare("UPDATE mcp_connections SET status='revoked' WHERE member_id=?").bind(memberId).run();
 const rejected=await realFetch(mcpRequest(token,'tools/call',{name:'notifications_mark_read',arguments:mark}));expect(rejected.status).toBe(401);
});

it.each((['owner','member','viewer'] as const).flatMap(ceiling=>(['owner','member','viewer'] as const).map(role=>({ceiling,role}))))('intersects current $role role with reviewed $ceiling ceiling for discovery and runtime',async({ceiling,role})=>{
 const oauth=await personalOAuth(ceiling,'role-subject'),token=oauth.tokens.access_token;
 await browserProof('owner','backup-owner');
 await env.DB.prepare("UPDATE members SET role=? WHERE id='role-subject'").bind(role).run();
 const listed=await rpc(await realFetch(mcpRequest(token))),names=listed.result.tools.map((t:{name:string})=>t.name);
 const writer=role!=='viewer'&&ceiling!=='viewer',owner=role==='owner'&&ceiling==='owner';
 for(const action of ['recipes_create','meals_create','contacts_create','meal_attendance_set'])expect(names.includes(action)).toBe(writer);
 for(const action of ['members_update','member_access_setup','member_password_reset'])expect(names.includes(action)).toBe(owner);
 for(const action of ['notifications_list','notification_preferences_set','sessions_list','connections_revoke','account_password_change','notification_device_setup'])expect(names).toContain(action);
 const shared=await rpc(await realFetch(mcpRequest(token,'tools/call',{name:'contacts_create',arguments:{operationId:'role-write',name:'Permitted',role:'Service'}})));
 expect(!!shared.result&&!shared.result.isError,JSON.stringify(shared)).toBe(writer);
 const access=await invoke(token,'connections_list',{memberId:'backup-owner'});
 expect(access?.isError===true).toBe(!owner);
 const handoff=await rpc(await realFetch(mcpRequest(token,'tools/call',{name:'member_access_setup',arguments:{}})));
 expect(!!handoff.result&&!handoff.result.isError).toBe(owner);
 const current=(await invoke(token,'home_context')).structuredContent;
 expect(current.member.role).toBe(role);expect(current.approvedRole).toBe(ceiling);expect(current.capabilities.includes('members_update')).toBe(owner);
});
it('returns usable absolute handoffs with no secret input or side effect and refuses dead reset targets',async()=>{
 const oauth=await personalOAuth('owner','handoff-owner'),token=oauth.tokens.access_token;
 await browserProof('member','reset-target');
 const expected={account_password_change:'/?view=account&action=password',member_access_setup:'/?view=members&action=create-member',member_password_reset:'/?view=members&action=reset-password&member=reset-target',notification_device_setup:'/?view=notifications&action=enable'};
 const before=await env.DB.prepare('SELECT COUNT(*) AS count FROM audit_events').first();
 for(const [action,path]of Object.entries(expected))expect(await invoke(token,action,action==='member_password_reset'?{memberId:'reset-target'}:{})).toMatchObject({structuredContent:{status:'requires_user_action',action,label:expect.any(String),destination:`https://home-os.test${path}`}});
 expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM audit_events').first()).toEqual(before);
 for(const memberId of ['handoff-owner','unknown-target'])expect(await invoke(token,'member_password_reset',{memberId})).toMatchObject({isError:true});
 await env.DB.prepare("UPDATE members SET archived_at=? WHERE id='reset-target'").bind(new Date().toISOString()).run();
 expect(await invoke(token,'member_password_reset',{memberId:'reset-target'})).toMatchObject({isError:true});
 const tools=(await rpc(await realFetch(mcpRequest(token)))).result.tools;
 for(const tool of tools.filter((t:{name:string})=>Object.hasOwn(expected,t.name)))expect(JSON.stringify(tool.inputSchema)).not.toMatch(/password|endpoint|p256dh|token|credential|subscription/i);
 for(const action of Object.keys(expected)){
  const forged=await rpc(await realFetch(mcpRequest(token,'tools/call',{name:action,arguments:{password:'secret',destination:'https://evil.example'}})));
  expect(forged.error||forged.result?.isError).toBeTruthy();
 }
});
it('uses real member updates and access revocation, preserves a usable Owner, and accepts self-revoke once',async()=>{
 const owner=await personalOAuth('owner','access-owner'),token=owner.tokens.access_token;
 const target=await personalOAuth('member','access-target');
 expect(await invoke(token,'members_update',{operationId:'profile',memberId:'access-target',name:'Housemate',role:'viewer'})).toMatchObject({structuredContent:{status:'accepted',member:{name:'Housemate',role:'viewer',active:true}}});
 expect(await data(await realFetch(browserRequest(owner.browser,'/api/v1/members')))).toMatchObject({members:expect.arrayContaining([expect.objectContaining({id:'access-target',name:'Housemate',role:'viewer'})])});
 expect(await invoke(token,'members_update',{operationId:'last-owner',memberId:'access-owner',active:false})).toMatchObject({isError:true,structuredContent:{code:'last_owner'}});
 const sessions=(await invoke(token,'sessions_list',{memberId:'access-target'})).structuredContent.sessions;
 expect(sessions).toHaveLength(1);expect(sessions[0]).toMatchObject({id:target.browser.sessionId,expiresAt:null});
 expect(await invoke(token,'sessions_revoke',{operationId:'end-target-browser',sessionId:sessions[0].id})).toMatchObject({structuredContent:{status:'accepted',revoked:true}});
 expect((await realFetch(browserRequest(target.browser,'/api/v1/members'))).status).toBe(401);
 const connections=(await invoke(token,'connections_list',{memberId:'access-target'})).structuredContent.connections;
 expect(connections[0]).toMatchObject({approvedRole:'member',status:'authorized'});
 expect(await invoke(token,'connections_revoke',{operationId:'end-target-client',connectionId:connections[0].id})).toMatchObject({structuredContent:{status:'accepted',revoked:true}});
 expect((await realFetch(mcpRequest(target.tokens.access_token))).status).toBe(401);
 expect(await invoke(token,'members_update',{operationId:'deactivate',memberId:'access-target',active:false})).toMatchObject({structuredContent:{member:{active:false}}});
 expect(await invoke(token,'members_update',{operationId:'reactivate',memberId:'access-target',active:true})).toMatchObject({structuredContent:{member:{active:true}}});
 expect((await realFetch(mcpRequest(target.tokens.access_token))).status).toBe(401);
 const own=(await invoke(token,'home_context')).structuredContent.currentConnectionId;
 expect(await invoke(token,'connections_revoke',{operationId:'end-self',connectionId:own})).toMatchObject({structuredContent:{status:'accepted',id:own,revoked:true}});
 expect((await realFetch(mcpRequest(token))).status).toBe(401);
 const refreshMeasure=measuredFetch();
 const refresh=await tokenRequest({grant_type:'refresh_token',client_id:owner.client.client_id,refresh_token:owner.tokens.refresh_token,resource},refreshMeasure.fetch);
 bindingCounts.refreshAfterSelfRevoke=refreshMeasure.requests.d1+refreshMeasure.requests.kv;expect(bindingCounts.refreshAfterSelfRevoke).toBeLessThanOrEqual(50);
 expect(refresh.status).toBe(400);expect(await refresh.json()).toMatchObject({error:'invalid_grant'});
 expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE operation_id='end-self'").first()).toMatchObject({count:1});
});

it('pages more than fifty dishes, meals, contacts and members at SQL boundaries without hydration N+1',async()=>{
 const oauth=await personalOAuth('viewer','page-reader'),token=oauth.tokens.access_token,now=new Date().toISOString();
 const recipeSql=`INSERT INTO recipes(id,household_id,name,description,servings,ingredients_json,instructions,labels_json,created_at,updated_at) VALUES(?,'home',?,'',4,'[{"name":"Unlinked"}]','Cook','[]',?,?)`;
 await env.DB.batch(Array.from({length:61},(_,i)=>env.DB.prepare(recipeSql).bind(`dish-${i.toString().padStart(3,'0')}`,i===60?'Äpfel':'Other dish',now,now)));
 await env.DB.batch(Array.from({length:61},(_,i)=>env.DB.prepare(`INSERT INTO contacts(id,household_id,name,role,created_at,updated_at) VALUES(?,'home',?,'Service',?,?)`).bind(`contact-${i.toString().padStart(3,'0')}`,i===60?'Äpfel':'Other contact',now,now)));
 await env.DB.batch(Array.from({length:61},(_,i)=>env.DB.prepare(`INSERT INTO members(id,household_id,display_name,role,created_at,updated_at) VALUES(?,'home',?,'member',?,?)`).bind(`roster-${i.toString().padStart(3,'0')}`,`Roster ${i}`,now,now)));
 await env.DB.batch(Array.from({length:61},(_,i)=>env.DB.prepare(`INSERT INTO meals(id,household_id,title,cooking_at,timezone,reminder_at,recipes_json,created_at,updated_at) VALUES(?,'home','Menu','2090-01-02T12:00:00Z','Asia/Kolkata','2090-01-02T11:00:00Z','[]',?,?)`).bind(`menu-${i.toString().padStart(3,'0')}`,now,now)));
 for(const [tool,key,base]of [['recipes_list','recipes',{}],['contacts_list','contacts',{}],['members_list','members',{}],['meals_list','meals',{from:'2090-01-02',to:'2090-01-03'}]] as const){
  const ids:string[]=[];let cursor:string|undefined;
  do{const page=(await invoke(token,tool,{...base,limit:50,...(cursor?{cursor}:{})})).structuredContent;expect(page[key].length).toBeLessThanOrEqual(50);expect(page.limit).toBe(50);ids.push(...page[key].map((x:{id:string})=>x.id));cursor=page.nextCursor??undefined;}while(cursor);
  expect(ids.length).toBeGreaterThanOrEqual(61);expect(new Set(ids).size).toBe(ids.length);
 }
 for(const [tool,key]of [['recipes_list','recipes'],['contacts_list','contacts']] as const){
  const first=(await invoke(token,tool,{search:'äpfel',limit:20})).structuredContent;expect(first[key]).toEqual([]);expect(first.nextCursor).toEqual(expect.any(String));
  const found:string[]=[];let cursor=first.nextCursor;
  do{const page=(await invoke(token,tool,{search:'äpfel',limit:20,cursor})).structuredContent;found.push(...page[key].map((x:{name:string})=>x.name));cursor=page.nextCursor;}while(cursor);
  expect(found).toEqual(['Äpfel']);
 }
 for(const tool of ['recipes_list','contacts_list','members_list'])expect(await invoke(token,tool,{cursor:'invalid'})).toMatchObject({isError:true,structuredContent:{status:'invalid'}});
 expect(await invoke(token,'meals_list',{from:'2090-01-03',to:'2090-01-02'})).toMatchObject({isError:true,structuredContent:{status:'invalid'}});
 expect(await invoke(token,'meals_list',{from:'2090-02-30',to:'2090-03-02'})).toMatchObject({isError:true,structuredContent:{status:'invalid'}});
});

it('batch-selects twelve dish snapshots and sixty linked ingredients without consuming stock',async()=>{
 const oauth=await personalOAuth('member','max-cook'),token=oauth.tokens.access_token;
 const item=(await invoke(token,'inventory_create',{operationId:'max-stock',name:'Rice',unit:'kg',trackingMode:'exact',quantity:100})).structuredContent.item;
 const ingredients=Array.from({length:60},()=>({name:'Rice',quantity:1,unit:'kg',inventoryItemId:item.id}));
 const ids:string[]=[];
 for(let i=0;i<12;i++)ids.push((await invoke(token,'recipes_create',{...recipeInput,ingredients,name:`Dish ${i}`,operationId:`max-dish-${i}`})).structuredContent.recipe.id);
 const m=(await invoke(token,'meals_create',{operationId:'max-meal',title:'Feast',recipeIds:ids,cookingAt:'2090-01-02T19:00'})).structuredContent.meal;
 expect(m.recipes).toHaveLength(12);expect(m.recipes.every((r:{ingredients:unknown[]})=>r.ingredients.length===60)).toBe(true);
 expect(await invoke(token,'meals_update',{operationId:'max-meal-update',mealId:m.id,expectedVersion:1,recipeIds:[...ids].reverse()})).toMatchObject({structuredContent:{meal:{announcementVersion:2,version:2}}});
 expect(await invoke(token,'recipes_list',{limit:50})).toMatchObject({structuredContent:{recipes:expect.arrayContaining([expect.objectContaining({availability:{state:'ready',ingredients:expect.any(Array)}})])}});
 expect(await invoke(token,'inventory_get',{itemId:item.id})).toMatchObject({structuredContent:{item:{quantity:100,version:1}}});
 await env.DB.prepare("UPDATE meals SET cooking_at='2000-01-02T12:00:00Z',reminder_at='2000-01-02T11:00:00Z' WHERE id=?").bind(m.id).run();
 expect(await invoke(token,'meal_attendance_set',{operationId:'past-answer',mealId:m.id,announcementVersion:2,expectedResponseVersion:0,response:'yes'})).toMatchObject({isError:true,structuredContent:{status:'invalid'}});
});
it('atomically protects concurrent removal of the last usable Owner',async()=>{
 const first=await personalOAuth('owner','owner-one'),second=await personalOAuth('owner','owner-two');
 const outcomes=await Promise.all([invoke(first.tokens.access_token,'members_update',{operationId:'demote-one',memberId:'owner-one',role:'member'}),invoke(second.tokens.access_token,'members_update',{operationId:'demote-two',memberId:'owner-two',role:'member'})]);
 expect(outcomes.filter(x=>x.structuredContent.status==='accepted')).toHaveLength(1);
 expect(outcomes.filter(x=>x.structuredContent.code==='last_owner')).toHaveLength(1);
 expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM members m JOIN auth_accounts a ON a.member_id=m.id WHERE m.household_id='home' AND m.role='owner' AND m.archived_at IS NULL").first()).toMatchObject({count:1});
});

it.each(['demotion','revocation','credentials','deactivation'] as const)('refuses cooking acceptance after current %s and emits neither receipt nor audit',async mode=>{
 const oauth=await personalOAuth('member','race-cook'),token=oauth.tokens.access_token;let changed=false;
 const database=new Proxy(env.DB,{get(target,key){
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{
   if(!changed){changed=true;
    if(mode==='demotion')await env.DB.prepare("UPDATE members SET role='viewer' WHERE id='race-cook'").run();
    if(mode==='revocation')await env.DB.prepare("UPDATE mcp_connections SET status='revoked' WHERE member_id='race-cook'").run();
    if(mode==='credentials')await env.DB.prepare("UPDATE auth_accounts SET credential_version=credential_version+1 WHERE member_id='race-cook'").run();
    if(mode==='deactivation')await env.DB.prepare("UPDATE members SET archived_at=? WHERE id='race-cook'").bind(new Date().toISOString()).run();
   }return target.batch(statements);
  };const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 const {countedD1,countedKV}=await import('./d1-budget');const db=countedD1(database,50,true),kv=countedKV(env.OAUTH_KV);
 expect(await invoke(token,'recipes_create',{...recipeInput,operationId:'racing-dish'},overriddenFetch({DB:db.database,OAUTH_KV:kv.namespace}))).toMatchObject({isError:true,structuredContent:{status:'refused'}});
 expect(changed).toBe(true);bindingCounts[`late-refusal:${mode}`]=db.calls()+kv.calls();expect(db.calls()+kv.calls()).toBeLessThanOrEqual(50);
 for(const table of ['household_command_receipts','audit_events'])expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE operation_id='racing-dish'`).first()).toMatchObject({count:0});
 expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM recipes WHERE name='Connected dal'").first()).toMatchObject({count:0});
});
it('sanitizes transient infrastructure errors and rejects forged household/actor/personal-subject fields',async()=>{
 const oauth=await personalOAuth('member','errors-cook'),token=oauth.tokens.access_token;
 const database=new Proxy(env.DB,{get(target,key){if(key==='prepare')return(sql:string)=>{if(sql.includes('SELECT * FROM recipes WHERE household_id'))throw new Error('password_hash=PRIVATE_PASSWORD token_hash=PRIVATE_TOKEN');return target.prepare(sql);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
 const response=await invoke(token,'recipes_list',{},overriddenFetch({DB:database}));
 expect(response).toMatchObject({isError:true,structuredContent:{status:'unavailable',code:'temporarily_unavailable'}});expect(JSON.stringify(response)).not.toMatch(/PRIVATE|password_hash|token_hash/);
 for(const field of ['actorId','householdId','authority','memberId']){
  const denied=await rpc(await realFetch(mcpRequest(token,'tools/call',{name:'meal_attendance_set',arguments:{operationId:`forged-${field}`,mealId:'unknown',response:'yes',announcementVersion:1,expectedResponseVersion:0,[field]:'local-owner'}})));
  expect(denied.error||denied.result?.isError).toBeTruthy();
 }
});

it.each(['notification_preferences_set','members_update'] as const)('refuses %s after its exact connection ends at atomic acceptance',async tool=>{
 const oauth=await personalOAuth('owner','race-owner'),token=oauth.tokens.access_token;await browserProof('member','race-target');let changed=false;
 const database=new Proxy(env.DB,{get(target,key){
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(!changed){changed=true;await env.DB.prepare("UPDATE mcp_connections SET status='revoked' WHERE member_id='race-owner'").run();}return target.batch(statements);};
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 const {countedD1,countedKV}=await import('./d1-budget');const db=countedD1(database,50,true),kv=countedKV(env.OAUTH_KV);
 const args=tool==='members_update'?{operationId:'private-race',memberId:'race-target',active:false}:{operationId:'private-race',mealReminders:false,pushEnabled:true};
 expect(await invoke(token,tool,args,overriddenFetch({DB:db.database,OAUTH_KV:kv.namespace}))).toMatchObject({isError:true,structuredContent:{status:'refused'}});
 expect(changed).toBe(true);bindingCounts[`late-refusal:${tool}`]=db.calls()+kv.calls();expect(db.calls()+kv.calls()).toBeLessThanOrEqual(50);
 for(const table of ['household_command_receipts','audit_events'])expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE operation_id='private-race'`).first()).toMatchObject({count:0});
 expect(await env.DB.prepare("SELECT archived_at FROM members WHERE id='race-target'").first()).toMatchObject({archived_at:null});
 expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM notification_preferences WHERE member_id='race-owner'").first()).toMatchObject({count:0});
});
it('fails stale handoff admission while retaining ordinary browser-only denial',async()=>{
 const {assertAuthority,authorityPredicate}=await import('../src/auth/authority');
 const {commandContext}=await import('../src/mcp/results');
 const {resolveDelegatedAuthority}=await import('../src/auth/connections');
 const oauth=await personalOAuth('owner','handoff-current'),token=oauth.tokens.access_token;
 const connection=(await invoke(token,'home_context')).structuredContent.currentConnectionId;
 const authority=await resolveDelegatedAuthority(env,connection,oauth.client.client_id,'handoff-current',resource);expect(authority).not.toBeNull();
 const command=commandContext({env,authority:authority!,clientId:oauth.client.client_id},'member_access_setup');
 await expect(assertAuthority(env.DB,command,'member_access_setup')).rejects.toMatchObject({code:'forbidden'});
 await expect(assertAuthority(env.DB,command,'member_access_setup',undefined,'handoff')).resolves.toBeUndefined();
 expect(authorityPredicate(command,'contacts_create',undefined,'handoff').sql).toBe('0');
 await browserProof('owner','handoff-backup');
 await env.DB.prepare("UPDATE members SET role='member' WHERE id='handoff-current'").run();
 await expect(assertAuthority(env.DB,command,'member_access_setup',undefined,'handoff')).rejects.toMatchObject({code:'forbidden'});
 await env.DB.prepare("UPDATE members SET role='owner' WHERE id='handoff-current'").run();
 await env.DB.prepare("UPDATE mcp_connections SET status='revoked' WHERE id=?").bind(connection).run();
 await expect(assertAuthority(env.DB,command,'member_access_setup',undefined,'handoff')).rejects.toMatchObject({code:'forbidden'});
});
