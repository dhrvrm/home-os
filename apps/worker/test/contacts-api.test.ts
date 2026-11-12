import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { cookingApi } from "./cooking-fixture";
import type { Contact } from "../src/contacts/model";
describe("contact API", () => {
  it("accepts empty HTTP body streams only for optional lifecycle input", async () => {
    const response = await cookingApi("/contacts", "POST", {
      name: "Empty-stream contact",
      role: "Maintenance",
    });
    const contact = (await response.json<{ data: { contact: Contact } }>()).data
      .contact;
    expect(
      (
        await cookingApi(`/contacts/${contact.id}`, "DELETE", undefined, {
          version: 1,
          emptyBodyStream: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await cookingApi(`/contacts/${contact.id}/restore`, "POST", undefined, {
          version: 2,
          emptyBodyStream: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await cookingApi("/contacts", "POST", undefined, {
          emptyBodyStream: true,
        })
      ).status,
    ).toBe(400);
  });
  it("creates, searches, edits, archives and restores safe household contacts", async () => {
    const input = {
      name: "Plumber",
      role: "Repairs",
      phone: "+91 (987) 654-3210",
      email: "plumber@example.com",
      address: "12 Main Street",
      labels: ["repair"],
      notes: "Morning",
    };
    const op = crypto.randomUUID();
    const res = await cookingApi("/contacts", "POST", input, { operation: op });
    expect(res.status).toBe(201);
    const c = (await res.json<{ data: { contact: Contact } }>()).data.contact;
    expect(c.phone).toBe("+919876543210");
    expect(c.address).toBe(input.address);
    const replay = await cookingApi("/contacts", "POST", input, {
      operation: op,
    });
    expect(
      (await replay.json<{ data: { contact: Contact } }>()).data.contact.id,
    ).toBe(c.id);
    expect(
      (
        await cookingApi(
          "/contacts",
          "POST",
          { ...input, name: "Different" },
          { operation: op },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await cookingApi(
          `/contacts/${c.id}`,
          "PATCH",
          { notes: "Afternoon" },
          { version: 1 },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await cookingApi(
          `/contacts/${c.id}`,
          "PATCH",
          { notes: "Stale" },
          { version: 1 },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await cookingApi(
          `/contacts/${c.id}`,
          "DELETE",
          { memberId: "spoof" },
          { version: 2 },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await cookingApi(`/contacts/${c.id}`, "DELETE", undefined, {
          version: 2,
        })
      ).status,
    ).toBe(200);
    const active = await cookingApi("/contacts?search=Plumber");
    expect(
      (await active.json<{ data: { contacts: Contact[] } }>()).data.contacts,
    ).toHaveLength(0);
    const archived = await cookingApi("/contacts?archived=only&search=repair");
    expect(
      (
        await archived.json<{ data: { contacts: Contact[] } }>()
      ).data.contacts.map((x) => x.id),
    ).toContain(c.id);
    expect(
      (
        await cookingApi(`/contacts/${c.id}/restore`, "POST", undefined, {
          version: 3,
        })
      ).status,
    ).toBe(200);
  });
  it("keeps foreign household contacts private", async () => {
    await env.DB.prepare(
      "INSERT INTO households (id,name,timezone,created_at,updated_at) VALUES ('foreign-contacts','Foreign','UTC','2090-01-01','2090-01-01')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO contacts (id,household_id,name,role,created_at,updated_at) VALUES ('private-contact','foreign-contacts','Secret','Doctor','2090-01-01','2090-01-01')",
    ).run();
    expect((await cookingApi("/contacts/private-contact")).status).toBe(404);
    expect(
      (
        await cookingApi(
          "/contacts/private-contact",
          "PATCH",
          { notes: "Override" },
          { version: 1 },
        )
      ).status,
    ).toBe(404);
    const list = await cookingApi("/contacts?search=Secret");
    expect(
      (await list.json<{ data: { contacts: Contact[] } }>()).data.contacts,
    ).toHaveLength(0);
  });
  it("rejects unsafe channels, empty contacts, actor claims and stale versions", async () => {
    for (const body of [
      { name: "A" },
      { name: "A", role: "Role", phone: "javascript:alert(1)" },
      { name: "A", role: "Role", email: "a@b\nBcc:evil" },
      { name: "A", role: "Role", address: "a".repeat(501) },
      { name: "A", role: "Role", memberId: "spoof" },
    ])
      expect((await cookingApi("/contacts", "POST", body)).status).toBe(400);
    expect(
      (
        await cookingApi(
          "/contacts/missing",
          "PATCH",
          { role: "Role" },
          { version: 1 },
        )
      ).status,
    ).toBe(404);
  });
});
