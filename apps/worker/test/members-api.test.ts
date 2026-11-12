import { env } from "cloudflare:test";
import { authenticatedFetch } from "./authenticated-worker";
import { describe, expect, it } from "vitest";

async function api(path: string, init?: RequestInit): Promise<Response> {
  return authenticatedFetch(new Request(`https://home-os.test${path}`, init));
}

interface MemberBody {
  id: string;
  name: string;
  active: boolean;
}

describe("household members HTTP API", () => {
  it("lists members with their active state", async () => {
    await env.DB.prepare(
      `INSERT INTO members (id, household_id, display_name, role, created_at, updated_at, archived_at)
       VALUES (?, 'home', ?, 'member', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
    )
      .bind("api-members-departed", "Departed housemate", "2026-09-01T00:00:00.000Z")
      .run();

    const listed = await api("/api/v1/members");
    expect(listed.status).toBe(200);
    const envelope = await listed.json<{ data: { members: MemberBody[] } }>();
    expect(envelope.data.members).toContainEqual(expect.objectContaining({ id: "local-owner", name: "Home owner", active: true }));
    expect(envelope.data.members).toContainEqual(expect.objectContaining({
      id: "api-members-departed",
      name: "Departed housemate",
      active: false,
    }));
  });
});
