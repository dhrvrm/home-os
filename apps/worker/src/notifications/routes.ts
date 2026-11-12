import { Hono } from "hono";
import { z } from "zod";
import { currentDeviceGrant, currentMember } from "../auth/session";
import type { Env } from "../env";
import { success } from "../http/envelope";
import { parsedJSON } from "../http/body";
import type { MealReminderSource } from "../meals/model";
import { HomeOSError } from "../platform/errors";
import { pushConfiguration } from "./push";
import { NotificationService } from "./service";
import { notificationId, parsePreferences, parseRead } from "./validation";

type BindingsEnv = { Bindings: Env };

export function createNotificationRoutes(
  sourceFor: (env: Env) => MealReminderSource,
): Hono<BindingsEnv> {
  const routes = new Hono<BindingsEnv>();
  routes.get("/notifications", async (context) => {
    const member = currentMember(context);
    const service = new NotificationService(
      context.env,
      member.householdId,
      sourceFor(context.env),
    );
    return success(
      context,
      await service.repository.list(member.id, new Date().toISOString()),
    );
  });
  routes.get("/notifications/preferences", async (context) => {
    const member = currentMember(context);
    const service = new NotificationService(
      context.env,
      member.householdId,
      sourceFor(context.env),
    );
    return success(context, {
      preferences: await service.repository.preferences(member.id),
    });
  });
  routes.put("/notifications/preferences", async (context) => {
    const member = currentMember(context);
    const service = new NotificationService(
      context.env,
      member.householdId,
      sourceFor(context.env),
    );
    return success(context, {
      preferences: await service.repository.setPreferences(
        member.id,
        parsePreferences(await parsedJSON(context, z.unknown())),
        new Date().toISOString(),
      ),
    });
  });
  routes.get("/notifications/config", async (context) =>
    success(context, await pushConfiguration(context.env)),
  );
  routes.get("/notifications/subscriptions/current", async (context) => {
    const member = currentMember(context);
    const service = new NotificationService(
      context.env,
      member.householdId,
      sourceFor(context.env),
    );
    return success(context, {
      subscription: await service.repository.currentSubscription(
        member.id,
        currentDeviceGrant(context),
        new Date().toISOString(),
      ),
    });
  });
  routes.put("/notifications/subscriptions/current", async (context) => {
    const member = currentMember(context);
    const service = new NotificationService(
      context.env,
      member.householdId,
      sourceFor(context.env),
    );
    return success(context, {
      subscription: await service.register(
        member.id,
        currentDeviceGrant(context),
        await parsedJSON(context, z.unknown()),
        new Date().toISOString(),
      ),
    });
  });
  routes.delete("/notifications/subscriptions/current", async (context) => {
    const member = currentMember(context);
    const service = new NotificationService(
      context.env,
      member.householdId,
      sourceFor(context.env),
    );
    await service.repository.deleteCurrentSubscription(
      member.id,
      currentDeviceGrant(context).tokenHash,
    );
    return success(context, { enabled: false });
  });
  routes.get("/notifications/:id/delivery-check", async (context) => {
    const member = currentMember(context);
    if (context.req.header("X-HomeOS-Member") !== member.id)
      throw new HomeOSError(
        "This reminder belongs to another sign-in.",
        "session_changed",
        409,
      );
    const service = new NotificationService(
      context.env,
      member.householdId,
      sourceFor(context.env),
    );
    return success(context, {
      notification: await service.deliveryCheck(
        member.id,
        currentDeviceGrant(context),
        notificationId(context.req.param("id")),
        new Date().toISOString(),
      ),
    });
  });
  routes.patch("/notifications/:id", async (context) => {
    const member = currentMember(context);
    parseRead(await parsedJSON(context, z.unknown()));
    const service = new NotificationService(
      context.env,
      member.householdId,
      sourceFor(context.env),
    );
    const notice = await service.repository.markRead(
      member.id,
      notificationId(context.req.param("id")),
      new Date().toISOString(),
    );
    if (!notice)
      throw new HomeOSError("Notification not found.", "not_found", 404);
    return success(context, { notification: notice });
  });
  return routes;
}
