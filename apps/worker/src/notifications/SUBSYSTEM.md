---
name: household-reminders
definition: >
  Brings a currently relevant household question to the intended person at
  the chosen time and keeps a bounded record they can revisit. One meal
  announcement gives each eligible person one logical reminder, even when
  delivery is retried or several devices belong to that person. Delivery
  requires the person's permission and continuing authority on that device;
  obsolete questions and expired authority cannot justify further attempts.
  Without this subsystem cooking plans require every member to remember to
  open the menu before the cook needs their answer.
inputs:
  - name: notification-intent
    description: >
      A person's intention to inspect or acknowledge their own reminders,
      enable or disable delivery, and register or retire a device they have
      explicitly permitted to receive them. Supplied by the household
      planning experience and confined to the admitted person's own state.
  - name: protected-action-admission
    description: >
      The household access decision and verified member authority for a
      personal reminder request. Required so one person cannot inspect or
      alter another person's inbox, permissions, or receiving devices.
  - name: meal-reminder-state
    description: >
      The current announced cooking question, due moment, cooking deadline,
      announcement identity, and unanswered eligible recipients supplied
      by household cooking. Required both when making a reminder due and
      before delivery, so a changed answer, cancelled meal, or changed
      announcement makes an earlier attempt ineligible.
  - name: notification-delivery-authority
    description: >
      The current household and device-grant admission supplied by household
      access for a proposed recipient. Required before each dispatch or
      retry so saved delivery permission cannot outlive sign-out, expiry,
      credential replacement, or departure from the household.
  - name: present-time
    description: >
      The trusted current moment and scheduled opportunities to act supplied
      by the execution environment. Required to deliver due questions while
      the app is closed, defer bounded retries, and expire obsolete inbox
      entries and delivery history.
  - name: notification-delivery-policy
    description: >
      The household operator's trusted sender identity and private authority
      to request delivery, supplied by the deployment environment. Required
      to keep delivery enabled only when the sender can be authenticated
      without exposing that authority to household readers.
  - name: notification-delivery-result
    description: >
      Whether the external delivery service accepted the request, rejected
      the receiving permission permanently, or reported a transient failure.
      Required to retire invalid destinations and bound retries without
      claiming that transport acceptance proves the person saw the reminder.
outputs:
  - name: notification-state
    description: >
      The admitted person's recent reminder inbox, reading state, delivery
      preference, and current device registration status. Supplied to the
      household planning experience without disclosing receiving secrets.
      Retention keeps at most fifty reminders or fourteen days per person.
  - name: notification-command-outcome
    description: >
      Whether a personal reminder request succeeded and its resulting
      visible state, or the reason it could not be applied. Supplied to the
      household planning experience so enabling delivery is never claimed
      merely because a permission prompt was shown.
  - name: notification-delivery-check
    description: >
      The proposed recipient, household, and exact continuing device grant
      supplied to household access for fresh admission before delivery.
      Required because a previously registered destination is insufficient
      evidence of a person's present authority on that device.
  - name: notification-delivery-request
    description: >
      The eligible recipient's due cooking question, its announcement
      identity, expiry, and return location, together with confidential
      receiving permission. Supplied to the external delivery service so
      the person's device can present the reminder and reopen the current
      meal without granting authority to answer on anyone's behalf.
---
