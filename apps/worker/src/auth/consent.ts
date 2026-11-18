import { AuthorizationError, type AuthRequest, type ConsentDescription, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { oauthMaintenanceHelpers } from "./oauth";
import type { AuthContext } from "./session";
import { currentAuthority, currentMember } from "./session";
import { commandContext } from "../http/request-context";
import { assertAuthority, authorizedBatch } from "./authority";
import { accessId, acceptedAccessBatch, consentChanged, maintainConnections } from "./connections";
import { capabilities, type Action, type Role } from "./permissions";
import { oauthReviewDestination } from "./handoffs";
import { HomeOSError } from "../platform/errors";

export interface ConsentPreview {
  id: string; client: ConsentDescription; resource: string; member: { id: string; name: string; role: Role };
  approvedRole: Role; capabilities: Action[]; expiresAt: string;
}
interface Intent {
  id: string; request_json: string; expires_at: string; status: string; reviewed_member_id: string | null;
  reviewed_role: Role | null; reviewed_credential_version: number | null; reviewed_session_hash: string | null; consent_handle: string | null;
}
export function appendProviderHeaders(context: AuthContext, headers: Headers): void {
  headers.forEach((value, name) => { if (name.toLowerCase() !== "set-cookie") context.header(name, value); });
  for (const cookie of headers.getSetCookie()) context.header("Set-Cookie", cookie, { append: true });
}
export async function startAuthorization(context: AuthContext, helpers: OAuthHelpers): Promise<Response> {
  const request = await helpers.parseAuthRequest(context.req.raw);
  if (!request.codeChallenge || request.codeChallengeMethod !== "S256") throw new AuthorizationError("invalid_request", { description: "PKCE S256 is required.", redirectUri: request.redirectUri, state: request.state, issuer: request.issuer });
  if (request.scope.length !== 1 || request.scope[0] !== "home:access") throw new AuthorizationError("invalid_scope", { description: "Request the home:access scope.", redirectUri: request.redirectUri, state: request.state, issuer: request.issuer });
  const id = crypto.randomUUID().replaceAll("-", ""), now = new Date().toISOString();
  await maintainConnections(context.env, oauthMaintenanceHelpers(context.env));
  await context.env.DB.prepare("INSERT INTO mcp_consent_intents (id, request_json, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(id, JSON.stringify(request), now, new Date(Date.now() + 600_000).toISOString()).run();
  context.header("Cache-Control", "no-store");
  return context.redirect(oauthReviewDestination(id), 302);
}
async function loadIntent(context: AuthContext, id: string): Promise<Intent> {
  if (!accessId.test(id)) throw consentChanged();
  const row = await context.env.DB.prepare("SELECT * FROM mcp_consent_intents WHERE id = ? AND status = 'pending' AND expires_at > ?")
    .bind(id, new Date().toISOString()).first<Intent>();
  if (!row) throw consentChanged();
  return row;
}
export async function previewConsent(context: AuthContext, helpers: OAuthHelpers, id: string): Promise<ConsentPreview> {
  const command = commandContext(context), authority = currentAuthority(context), member = currentMember(context);
  if (authority.proof.kind !== "browser") throw consentChanged();
  const intent = await loadIntent(context, id), request = JSON.parse(intent.request_json) as AuthRequest;
  const client = await helpers.describeConsent(request), consent = await helpers.beginConsent(request);
  const results = await authorizedBatch(context.env.DB, command, "connection_authorize", [
    context.env.DB.prepare(`UPDATE mcp_consent_intents SET reviewed_member_id = ?, reviewed_role = ?, reviewed_credential_version = ?, reviewed_session_hash = ?, consent_handle = ?
      WHERE id = ? AND status = 'pending' AND expires_at > ? AND EXISTS (SELECT 1 FROM members WHERE id = ? AND role = ?)`)
      .bind(member.id, member.role, authority.proof.credentialVersion, authority.proof.tokenHash, consent.handle, id, new Date().toISOString(), member.id, member.role),
  ]);
  if (results[0]!.meta.changes !== 1) throw consentChanged();
  appendProviderHeaders(context, consent.headers);
  return { id, client, resource: request.resource!, member: { id: member.id, name: member.name, role: member.role }, approvedRole: member.role,
    capabilities: capabilities({ memberId: member.id, householdId: member.householdId, role: member.role, ceiling: member.role, kind: "delegated" }), expiresAt: intent.expires_at };
}
export async function decideConsent(context: AuthContext, helpers: OAuthHelpers, id: string, decision: "approve" | "deny"): Promise<{ redirectTo: string }> {
  const intent = await loadIntent(context, id), authority = currentAuthority(context), member = currentMember(context), command = commandContext(context);
  if (authority.proof.kind !== "browser" || intent.reviewed_member_id !== member.id || intent.reviewed_role !== member.role ||
    intent.reviewed_credential_version !== authority.proof.credentialVersion || intent.reviewed_session_hash !== authority.proof.tokenHash || !intent.consent_handle) throw consentChanged();
  const connectionId = crypto.randomUUID().replaceAll("-", ""), request = JSON.parse(intent.request_json) as AuthRequest;
  const consume = context.env.DB.prepare(`UPDATE mcp_consent_intents SET status = 'consumed', consent_handle = NULL WHERE id = ? AND status = 'pending' AND expires_at > ?
    AND reviewed_member_id = ? AND reviewed_role = ? AND reviewed_credential_version = ? AND reviewed_session_hash = ?
    AND EXISTS (SELECT 1 FROM members WHERE id = ? AND role = ?)`)
    .bind(id, new Date().toISOString(), member.id, member.role, authority.proof.credentialVersion, authority.proof.tokenHash, member.id, member.role);
  const consumed = await authorizedBatch(context.env.DB, command, "connection_authorize", [consume]);
  if (consumed[0]!.meta.changes !== 1) throw consentChanged();
  if (decision === "deny") {
    const denied = await helpers.denyConsent(context.req.raw, intent.consent_handle);
    appendProviderHeaders(context, denied.headers);
    return { redirectTo: denied.redirectTo };
  }
  // Pending authority is never admitted. The exact reviewed identity/role is checked again on activation.
  const now = new Date().toISOString();
  const pending = await authorizedBatch(context.env.DB, command, "connection_authorize", [context.env.DB.prepare(`INSERT INTO mcp_connections
    (id, member_id, household_id, credential_version, client_id, client_name, resource, approved_role, status, created_at, exchange_until)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ? WHERE NOT EXISTS (SELECT 1 FROM oauth_registrations WHERE client_id = ? AND cleanup_nonce IS NOT NULL)`)
    .bind(connectionId, member.id, member.householdId, authority.proof.credentialVersion, request.clientId, (await helpers.describeConsent(request)).clientName, request.resource!, member.role, now, new Date(Date.now() + 600_000).toISOString(), request.clientId)]);
  if (pending[0]!.meta.changes !== 1) throw consentChanged();
  try {
    const approved = await helpers.approveConsent(context.req.raw, intent.consent_handle, { scope: ["home:access"] });
    appendProviderHeaders(context, approved.headers);
    if (JSON.stringify(approved.request) !== JSON.stringify(request)) throw consentChanged();
    const completed = await helpers.completeAuthorization({ request: approved.request, userId: member.id, metadata: { connectionId }, props: { connectionId }, scope: ["home:access"], revokeExistingGrants: false });
    await acceptedAccessBatch(context.env.DB, command, "connection_authorize", { householdId: member.householdId, memberId: member.id }, {
      entityType: "mcp_connection", id: connectionId, event: "connection.authorized", exists: "EXISTS (SELECT 1 FROM mcp_connections WHERE id = ? AND status = 'pending')", values: [connectionId],
      statements: [
        context.env.DB.prepare(`INSERT INTO mutation_guards (household_id, operation_id, expected_version, actual_version)
          VALUES (?, ?, 1, EXISTS (SELECT 1 FROM mcp_connections c JOIN members m ON m.id = c.member_id WHERE c.id = ? AND c.status = 'pending' AND c.exchange_until > ? AND m.role = ?))`)
          .bind(member.householdId, `${command.operationId}:consent`, connectionId, new Date().toISOString(), member.role),
        context.env.DB.prepare(`UPDATE mcp_connections SET status = 'revoked', ended_at = ?, cleanup_pending = 1
          WHERE member_id = ? AND household_id = ? AND client_id = ? AND resource = ? AND status = 'active' AND id <> ?`)
          .bind(now, member.id, member.householdId, request.clientId, request.resource!, connectionId),
        context.env.DB.prepare("UPDATE mcp_connections SET status = 'active', approved_at = ? WHERE id = ? AND status = 'pending'").bind(now, connectionId),
        context.env.DB.prepare("DELETE FROM oauth_registrations WHERE client_id = ? AND cleanup_nonce IS NULL").bind(request.clientId),
        context.env.DB.prepare("DELETE FROM mutation_guards WHERE household_id = ? AND operation_id = ?").bind(member.householdId, `${command.operationId}:consent`),
      ],
    });
    // Cleanup cannot turn an accepted D1 replacement into an application failure.
    await maintainConnections(context.env, oauthMaintenanceHelpers(context.env)).catch(() => {});
    return { redirectTo: completed.redirectTo };
  } catch (error) {
    await context.env.DB.prepare("UPDATE mcp_connections SET status = 'failed', ended_at = ?, cleanup_pending = 1 WHERE id = ? AND status = 'pending'").bind(new Date().toISOString(), connectionId).run().catch(() => {});
    await assertAuthority(context.env.DB, command, "connection_authorize");
    const currentRole = await context.env.DB.prepare("SELECT role FROM members WHERE id = ?").bind(member.id).first<{ role: Role }>();
    if (currentRole?.role !== member.role) throw consentChanged();
    if (error instanceof AuthorizationError || error instanceof HomeOSError) throw error;
    throw new HomeOSError("Home OS could not complete authorization. Start again.", "authorization_unavailable", 503);
  }
}
