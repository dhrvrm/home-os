import {
  hasNotificationDeliveryAuthority,
  type DeviceGrant,
} from "../auth/session";
import { digest } from "../auth/crypto";
import type { Env } from "../env";
import type { MealReminderSource } from "../meals/model";
import { HomeOSError } from "../platform/errors";
import { NotificationRepository } from "./d1-repository";
import { pushConfiguration } from "./push";
import { validateNativeSubscription } from "./validation";

export class NotificationService {
  readonly repository: NotificationRepository;
  constructor(
    readonly env: Env,
    readonly householdId: string,
    readonly source: MealReminderSource,
  ) {
    this.repository = new NotificationRepository(env.DB, householdId);
  }

  async register(
    memberId: string,
    grant: DeviceGrant,
    value: unknown,
    now: string,
  ) {
    if (!(await pushConfiguration(this.env)).pushAvailable)
      throw new HomeOSError(
        "Device notifications are not configured. Your inbox is still available.",
        "push_unavailable",
        503,
      );
    const subscription = await validateNativeSubscription(
      value,
      Date.parse(now),
    );
    if (
      !(await hasNotificationDeliveryAuthority(
        this.env.DB,
        this.householdId,
        memberId,
        grant.tokenHash,
        now,
      ))
    ) {
      throw new HomeOSError(
        "Your session has ended. Sign in again.",
        "unauthorized",
        401,
      );
    }
    return this.repository.registerSubscription(
      memberId,
      grant,
      subscription,
      await digest(subscription.endpoint),
      now,
    );
  }

  async deliveryCheck(
    memberId: string,
    grant: DeviceGrant,
    notificationId: string,
    now: string,
  ) {
    const notice = await this.repository.notification(
      memberId,
      notificationId,
      now,
    );
    const preferences = await this.repository.preferences(memberId);
    if (
      !notice ||
      !preferences.mealReminders ||
      !preferences.pushEnabled ||
      !(await this.repository.currentSubscription(memberId, grant, now))
        .enabled ||
      !(await hasNotificationDeliveryAuthority(
        this.env.DB,
        this.householdId,
        memberId,
        grant.tokenHash,
        now,
      )) ||
      !(await this.source.isMealReminderEligible(
        this.householdId,
        notice.mealId,
        notice.announcementVersion,
        memberId,
        now,
      ))
    ) {
      throw new HomeOSError(
        "This reminder is no longer available on this device.",
        "notification_unavailable",
        404,
      );
    }
    return notice;
  }
}
