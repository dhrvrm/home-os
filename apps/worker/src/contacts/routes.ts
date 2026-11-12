import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { currentMember } from "../auth/session";
import { success } from "../http/envelope";
import { parsedJSON } from "../http/body";
import { commandContext } from "../http/request-context";
import { ValidationError } from "../platform/errors";
import { D1ContactRepository } from "./d1-repository";
import { ContactService } from "./service";
import {
  archivedFilter,
  contactSchema,
  contactUpdateSchema,
  identifier,
  validate,
} from "./validation";

function service(context: Context<{ Bindings: Env }>): ContactService {
  return new ContactService(new D1ContactRepository(context.env.DB));
}

function command(context: Context<{ Bindings: Env }>) {
  if (!context.req.header("X-Operation-ID")?.trim()) {
    throw new ValidationError("X-Operation-ID", "provide an operation ID");
  }
  return commandContext(context);
}

export function createContactRoutes(): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>();
  routes.get("/contacts", async (context) => {
    const contacts = await service(context).listContacts(
      currentMember(context).householdId,
      {
        search: context.req.query("search"),
        archived: archivedFilter(context.req.query("archived")),
      },
    );
    return success(context, { contacts });
  });
  routes.get("/contacts/:id", async (context) => {
    const contact = await service(context).getContact(
      currentMember(context).householdId,
      validate(identifier, context.req.param("id")),
    );
    return success(context, { contact });
  });
  routes.post("/contacts", async (context) => {
    const contact = await service(context).createContact(
      command(context),
      await parsedJSON(context, contactSchema),
    );
    return success(context, { contact }, 201);
  });
  routes.patch("/contacts/:id", async (context) => {
    const contact = await service(context).updateContact(
      command(context),
      validate(identifier, context.req.param("id")),
      await parsedJSON(context, contactUpdateSchema),
    );
    return success(context, { contact });
  });
  routes.delete("/contacts/:id", async (context) => {
    await parsedJSON(context, z.object({}).strict(), { allowEmpty: true });
    const contact = await service(context).archiveContact(
      command(context),
      validate(identifier, context.req.param("id")),
    );
    return success(context, { contact });
  });
  routes.post("/contacts/:id/restore", async (context) => {
    await parsedJSON(context, z.object({}).strict(), { allowEmpty: true });
    const contact = await service(context).restoreContact(
      command(context),
      validate(identifier, context.req.param("id")),
    );
    return success(context, { contact });
  });
  return routes;
}
