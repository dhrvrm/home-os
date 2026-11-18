import { Hono } from "hono";
import type { Env } from "../env";
import {
  MemberService,
  createMemberSchema,
  updateMemberSchema,
  resetMemberPasswordSchema,
} from "../auth/members";
import { currentMember, passwordPepper } from "../auth/session";
import { parsedJSON } from "./body";
import { commandContext } from "./request-context";
import { success } from "./envelope";
export function createMemberRoutes(): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>();
  routes.get("/members", async (c) =>
    success(c, {
      members: await new MemberService(c.env.DB).listMembers(
        currentMember(c).householdId,
      ),
    }),
  );
  routes.post("/members", async (c) =>
    success(
      c,
      await new MemberService(c.env.DB).createMember(
        commandContext(c),
        await parsedJSON(c, createMemberSchema),
        passwordPepper(c.env),
      ),
      201,
    ),
  );
  routes.patch("/members/:id", async (c) =>
    success(
      c,
      await new MemberService(c.env.DB).updateMember(
        commandContext(c),
        c.req.param("id"),
        await parsedJSON(c, updateMemberSchema),
      ),
    ),
  );
  routes.post("/members/:id/password", async (c) =>
    success(
      c,
      await new MemberService(c.env.DB).resetPassword(
        commandContext(c),
        c.req.param("id"),
        await parsedJSON(c, resetMemberPasswordSchema),
        passwordPepper(c.env),
      ),
    ),
  );
  return routes;
}
