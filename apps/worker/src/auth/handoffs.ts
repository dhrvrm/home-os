import { ValidationError } from "../platform/errors";
import { accessId } from "./connections";
export type InteractiveAction = "account_password_change" | "member_access_setup" | "member_password_reset" | "notification_device_setup";
export function interactiveHandoff(action: InteractiveAction, memberId?: string): { status: "requires_user_action"; action: InteractiveAction; label: string; destination: string } {
  if (action === "member_password_reset" && (!memberId || !/^[A-Za-z0-9_-]{1,128}$/.test(memberId))) throw new ValidationError("memberId", "is invalid");
  const entries = {
    account_password_change: ["Change your password", "/?view=account&action=password"],
    member_access_setup: ["Set up member access", "/?view=members&action=create-member"],
    member_password_reset: ["Reset member password", `/?view=members&action=reset-password&member=${encodeURIComponent(memberId ?? "")}`],
    notification_device_setup: ["Enable reminders on this device", "/?view=notifications&action=enable"],
  } as const;
  const [label, destination] = entries[action];
  return { status: "requires_user_action", action, label, destination };
}
export function oauthReviewDestination(intentId: string): string {
  if (!accessId.test(intentId)) throw new ValidationError("connect", "is invalid");
  return `/api/oauth/consent?connect=${intentId}`;
}
