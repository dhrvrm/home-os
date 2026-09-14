import { Hono } from "hono";
import type { Env } from "../env";
import { success } from "./envelope";

interface MemberRow {
  id: string;
  display_name: string;
  archived_at: string | null;
}

export function createMemberRoutes(): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>();

  routes.get("/members", async (context) => {
    const result = await context.env.DB.prepare(
      "SELECT id, display_name, archived_at FROM members WHERE household_id = ? ORDER BY display_name ASC",
    )
      .bind(context.env.HOMEOS_DEFAULT_HOUSEHOLD_ID)
      .all<MemberRow>();
    const members = result.results.map((row) => ({
      id: row.id,
      name: row.display_name,
      active: row.archived_at === null,
    }));
    return success(context, { members });
  });

  return routes;
}
