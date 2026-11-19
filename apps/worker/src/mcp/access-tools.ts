import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { MemberService, updateMemberSchema } from '../auth/members';
import { SessionAccessService } from '../auth/session-access';
import { ConnectionAccessService } from '../auth/connections';
import { assertAuthority, permissionIdentity } from '../auth/authority';
import { capabilities, handoffCapabilities, permitsHandoff } from '../auth/permissions';
import { interactiveHandoff, type InteractiveAction } from '../auth/handoffs';
import { pageInput } from '../inventory/validation';
import { HomeOSError } from '../platform/errors';
import { D1MealRepository } from '../meals/d1-repository';
import { commandContext, failure, mutationInput, readOnlyAnnotations, registerTool, result, subjectId, type ToolContext } from './results';

function registerHandoff(server:McpServer,context:ToolContext,action:InteractiveAction,members:MemberService) {
 const subject={householdId:context.authority.householdId,memberId:context.authority.memberId};
 if(!permitsHandoff(permissionIdentity(context.authority),action,subject))return;
 server.registerTool(action,{description:'Open the trusted Home OS form. The person must complete this action directly; opening the form performs no mutation or native permission request.',inputSchema:(action==='member_password_reset'?z.object({memberId:subjectId}):z.object({})).strict(),annotations:readOnlyAnnotations},async input=>{
  const command=commandContext(context,action);
  try {
   await assertAuthority(context.env.DB,command,action,subject,'handoff');
   const memberId='memberId' in input?input.memberId:undefined;
   if(action==='member_password_reset') {
    if(memberId===command.actorId)throw new HomeOSError('Use account_password_change to replace your own password.','invalid_request',400);
    const target=await members.getMember(command.householdId,memberId!);
    if(!target.active || !target.email)throw new HomeOSError('Choose an active member with a sign-in email before resetting access.','invalid_request',400);
   }
   const handoff=interactiveHandoff(action,memberId);
   const resource=new URL(context.env.HOMEOS_MCP_RESOURCE);
   if(resource.protocol!=='https:')throw new Error('Invalid trusted household origin');
   await assertAuthority(context.env.DB,command,action,subject,'handoff');
   return result({...handoff,destination:new URL(handoff.destination,resource.origin).href});
  }catch(error){
   try{await assertAuthority(context.env.DB,command,action,subject,'handoff');}catch(admission){return failure(admission);}
   return failure(error);
  }
 });
}
export function registerAccessTools(server:McpServer,context:ToolContext) {
 const members=new MemberService(context.env.DB),sessions=new SessionAccessService(context.env.DB),connections=new ConnectionAccessService(context.env.DB);
 registerTool(server,context,'home_context','Read your current identity, household timezone/local date, effective capabilities, reviewed ceiling and public current connection ID.',z.object({}),true,async(_,command)=>{
  const member=await members.getMember(command.householdId,command.actorId),timezone=await new D1MealRepository(context.env.DB).timezone(command.householdId),now=new Date();
  const current=permissionIdentity(context.authority,member.role);
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const part=(type:string)=>parts.find(p=>p.type===type)!.value;
  return {member,householdId:command.householdId,timezone,now:now.toISOString(),localDate:`${part('year')}-${part('month')}-${part('day')}`,capabilities:capabilities(current),handoffs:handoffCapabilities(current),approvedRole:current.ceiling??null,currentConnectionId:context.authority.proof.kind==='delegated'?context.authority.proof.connectionId:null};
 });
 registerTool(server,context,'members_list','Page the household roster with public identity, role, active state and sign-in status; no login proof is returned.',pageInput,true,async input=>members.listMembersPage(context.authority.householdId,input));
 registerTool(server,context,'members_update','Owner: change non-secret member profile, role or active state. At least one active Owner with established login remains.',updateMemberSchema.extend(mutationInput.shape).extend({memberId:subjectId}),false,async({memberId,operationId:_,...input},command)=>({status:'accepted',...await members.updateMember(command,memberId,input)}));
 const accessPage=z.object({memberId:subjectId.optional(),limit:z.number().int().min(1).max(50).default(25),cursor:z.string().max(128).optional()});
 registerTool(server,context,'sessions_list','Page your live browser sessions; Owners may select another household member.',accessPage,true,async(input,command)=>({...await sessions.listSessions(command,input),limit:input.limit}));
 registerTool(server,context,'connections_list','Page your connected clients; Owners may select another household member. Status is authorization, not online presence.',accessPage,true,async(input,command)=>({...await connections.listConnections(command,input),limit:input.limit}));
 registerTool(server,context,'sessions_revoke','End one public browser session ID; Owners may end a household member session.',mutationInput.extend({sessionId:subjectId}),false,async(input,command)=>({status:'accepted',...await sessions.revokeSession(command,input.sessionId)}));
 registerTool(server,context,'connections_revoke','End one public connection ID immediately. Ending your current connection accepts once and prevents future calls and refresh.',mutationInput.extend({connectionId:subjectId}),false,async(input,command)=>({status:'accepted',...await connections.revokeConnection(command,input.connectionId)}));
 for(const action of ['account_password_change','member_access_setup','member_password_reset','notification_device_setup'] as const)registerHandoff(server,context,action,members);
}
