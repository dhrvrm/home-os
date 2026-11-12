import { digest } from "../auth/crypto";
import { hasNotificationDeliveryAuthority } from "../auth/session";
import type { Env } from "../env";
import type { MealReminderSource } from "../meals/model";
import {
  MAX_DELIVERY_ATTEMPTS,
  nativeSubscription,
  NotificationRepository,
  type SubscriptionRow,
  type DeliveryRow,
} from "./d1-repository";
import { pushConfiguration, sendMealPush, type PushFetch } from "./push";
import { validateNativeSubscription } from "./validation";

export interface NotificationTickSummary {
  candidates: number;
  attempted: number;
  accepted: number;
  retried: number;
  retired: number;
  suppressed: number;
  failed: number;
}
/** A tick uses trusted wall time. The optional clock/fetch arguments are controlled test seams. */
export async function runNotificationTick(
  env: Env,
  source: MealReminderSource,
  nowISO?: string,
  options: { fetcher?: PushFetch } = {},
): Promise<NotificationTickSummary> {
  const started = Date.now();
  const base = nowISO === undefined ? started : Date.parse(nowISO);
  if (!Number.isFinite(base)) throw new Error("Invalid reminder clock");
  const currentTime = () => new Date(base + Date.now() - started).toISOString();
  const householdId = env.HOMEOS_DEFAULT_HOUSEHOLD_ID;
  const repository = new NotificationRepository(env.DB, householdId);
  const summary: NotificationTickSummary = {
    candidates: 0,
    attempted: 0,
    accepted: 0,
    retried: 0,
    retired: 0,
    suppressed: 0,
    failed: 0,
  };
  await repository.prune(currentTime());
  const due = await source.listDueMealReminders(
    householdId,
    currentTime(),
    50,
    await repository.scanCursor(),
  );
  const page = due.slice(0, 50);
  for (const candidate of page) {
    const now = currentTime();
    if (
      candidate.reminderAt > now ||
      candidate.cookingAt <= now ||
      !(await source.isMealReminderEligible(
        householdId,
        candidate.mealId,
        candidate.announcementVersion,
        candidate.memberId,
        now,
      ))
    )
      continue;
    if (!(await repository.preferences(candidate.memberId)).mealReminders)
      continue;
    const id = `meal_${await digest(JSON.stringify([householdId, candidate.mealId, candidate.announcementVersion, candidate.memberId]))}`;
    await repository.createReminder(id, candidate, now);
    summary.candidates++;
  }
  await repository.saveScanCursor(
    page.length === 50 ? (page.at(-1)?.cursor ?? null) : null,
  );
  await repository.prune(currentTime());
  if (!(await pushConfiguration(env)).pushAvailable) return summary;
  const deliveries = await repository.dueDeliveries(currentTime(), 20);

  async function allowed(
    subscription: SubscriptionRow,
    delivery: DeliveryRow,
    now: string,
  ): Promise<boolean> {
    if (
      delivery.reminder_at > now ||
      delivery.cooking_at <= now ||
      (subscription.expiration_time !== null &&
        subscription.expiration_time <= Date.parse(now))
    )
      return false;
    const preferences = await repository.preferences(delivery.member_id);
    return (
      preferences.mealReminders &&
      preferences.pushEnabled &&
      (await hasNotificationDeliveryAuthority(
        env.DB,
        householdId,
        delivery.member_id,
        subscription.session_hash,
        now,
      )) &&
      (await source.isMealReminderEligible(
        householdId,
        delivery.meal_id,
        delivery.announcement_version,
        delivery.member_id,
        now,
      ))
    );
  }

  let cursor = 0;
  async function consume(): Promise<void> {
    while (cursor < deliveries.length) {
      const delivery = deliveries[cursor++]!;
      const now = currentTime();
      const token = crypto.randomUUID();
      if (!(await repository.claim(delivery.id, now, token))) continue;
      const subscription = await repository.subscription(
        delivery.subscription_id,
        delivery.member_id,
      );
      if (
        !subscription ||
        !(await allowed(subscription, delivery, currentTime()))
      ) {
        await repository.settle(
          delivery.id,
          token,
          "suppressed",
          currentTime(),
          currentTime(),
          null,
        );
        summary.suppressed++;
        continue;
      }
      try {
        await validateNativeSubscription(
          nativeSubscription(subscription),
          Date.parse(currentTime()),
        );
      } catch {
        await repository.retireClaimedSubscription(
          subscription.id,
          delivery.member_id,
          delivery.id,
          token,
          subscription,
        );
        summary.retired++;
        continue;
      }
      let suppressed = false;
      try {
        const outcome = await sendMealPush(
          env,
          nativeSubscription(subscription),
          {
            notificationId: delivery.notification_id,
            memberId: delivery.member_id,
            mealId: delivery.meal_id,
            url: delivery.url,
          },
          currentTime(),
          delivery.cooking_at,
          async (url, request) => {
            // Encryption is asynchronous: perform fresh admission immediately before the network dispatch.
            const fresh = await repository.subscription(
              subscription.id,
              delivery.member_id,
            );
            if (
              !fresh ||
              fresh.session_hash !== subscription.session_hash ||
              fresh.endpoint !== subscription.endpoint ||
              fresh.p256dh !== subscription.p256dh ||
              fresh.auth !== subscription.auth ||
              !(await allowed(fresh, delivery, currentTime())) ||
              !(await repository.ownsClaim(
                delivery.id,
                token,
                currentTime(),
              )) ||
              delivery.cooking_at <= currentTime() ||
              (fresh.session_expires_at !== undefined &&
                fresh.session_expires_at <= currentTime()) ||
              (fresh.expiration_time !== null &&
                fresh.expiration_time <= Date.parse(currentTime()))
            ) {
              suppressed = true;
              throw new Error("Reminder admission ended");
            }
            summary.attempted++;
            return (options.fetcher ?? fetch)(url, request);
          },
        );
        const ended = currentTime();
        if (suppressed) {
          await repository.settle(
            delivery.id,
            token,
            "suppressed",
            ended,
            ended,
            null,
          );
          summary.suppressed++;
        } else if (outcome.kind === "retired") {
          if (
            await repository.retireClaimedSubscription(
              subscription.id,
              delivery.member_id,
              delivery.id,
              token,
              subscription,
            )
          )
            summary.retired++;
        } else {
          const next = new Date(
            Date.parse(ended) +
              Math.min(15 * 60_000, 30_000 * 2 ** delivery.attempt_count),
          ).toISOString();
          const retry =
            outcome.kind === "retry" &&
            delivery.attempt_count + 1 < MAX_DELIVERY_ATTEMPTS &&
            next < delivery.cooking_at;
          const state =
            outcome.kind === "accepted"
              ? "accepted"
              : retry
                ? "pending"
                : "failed";
          if (
            await repository.settle(
              delivery.id,
              token,
              state,
              ended,
              retry ? next : ended,
              outcome.status,
            )
          ) {
            if (state === "accepted") summary.accepted++;
            else if (state === "pending") summary.retried++;
            else summary.failed++;
          }
        }
      } catch {
        // Invalid local sender/payload state is terminal; secrets never enter logs or audit.
        if (
          await repository.settle(
            delivery.id,
            token,
            "failed",
            currentTime(),
            currentTime(),
            null,
          )
        )
          summary.failed++;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(4, deliveries.length) }, () => consume()),
  );
  return summary;
}
