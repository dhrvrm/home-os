import { env, exports } from "cloudflare:workers";
import { digest, hashPassword } from "../src/auth/crypto";

const ownerToken = "a".repeat(64);
let ownerHash: Promise<string> | undefined;

/** Test fixture admission through the real production cookie middleware. */
export async function authenticatedFetch(request: Request): Promise<Response> {
  ownerHash ??= hashPassword("fixture owner password", "test-pepper-at-least-thirty-two-characters-long");
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO auth_accounts (member_id, email, password_hash, updated_at) VALUES ('local-owner', 'fixture-owner@home-os.test', ?, ?)")
      .bind(await ownerHash, new Date().toISOString()),
    env.DB.prepare("INSERT OR IGNORE INTO auth_sessions (token_hash, member_id, credential_version, expires_at, created_at) VALUES (?, 'local-owner', 1, '2099-01-01T00:00:00.000Z', ?)")
      .bind(await digest(ownerToken), new Date().toISOString()),
  ]);
  const headers = new Headers(request.headers);
  headers.set("Cookie", `homeos_session=${ownerToken}`);
  headers.set("Origin", new URL(request.url).origin);
  headers.set("X-HomeOS-Member", "local-owner");
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return exports.default.fetch(new Request(request, { headers }));
}
